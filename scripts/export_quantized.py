"""把 Krea-2-Turbo 的 transformer/text_encoder 预量化导出为独立模型目录。

启动时读预量化权重可省一半（int8）/四分之三（int4）读盘量，并免去每次现场量化，
冷启动显著加快。VAE/tokenizer/scheduler 不参与量化，仍从主目录读取。

用法:
    .venv/bin/python scripts/export_quantized.py [int8|int4|all]   # 默认 all

产物（可随时整目录删除，pipeline 会自动回退现场量化）:
    /home/feifei/develop/models/Krea-2-Turbo-int8/{transformer,text_encoder}
    /home/feifei/develop/models/Krea-2-Turbo-int4/{transformer,text_encoder}

注意: 逐组件导出、组件间 del + malloc_trim，避免 25G bf16 与量化副本同驻 RAM。
量化配置嵌入各组件的 config.json，回读时无需再传 quantization_config。
"""

import gc
import sys
import time
from pathlib import Path

import torch

BASE = Path("/home/feifei/develop/models/Krea-2-Turbo")
OUT_ROOT = BASE.parent


def _trim() -> None:
    gc.collect()
    try:
        import ctypes
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:  # noqa: BLE001
        pass


def _export(precision: str) -> None:
    from diffusers import Krea2Transformer2DModel
    from transformers import Qwen3VLModel

    out = OUT_ROOT / f"{BASE.name}-{precision}"
    if precision == "int8":
        from diffusers import TorchAoConfig
        from torchao.quantization import Int8WeightOnlyConfig
        t_cfg = TorchAoConfig(Int8WeightOnlyConfig())
        from transformers import TorchAoConfig as HFCfg
        e_cfg = HFCfg(Int8WeightOnlyConfig())
    else:
        from diffusers import BitsAndBytesConfig
        t_cfg = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                                   bnb_4bit_compute_dtype=torch.bfloat16)
        from transformers import BitsAndBytesConfig as HFCfg
        e_cfg = HFCfg(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                      bnb_4bit_compute_dtype=torch.bfloat16)

    out.mkdir(parents=True, exist_ok=True)
    for name, cls, cfg in (("transformer", Krea2Transformer2DModel, t_cfg),
                           ("text_encoder", Qwen3VLModel, e_cfg)):
        dst = out / name
        if (dst / "config.json").exists():
            print(f"[{precision}] {name}: 已存在，跳过（删除目录可重导）")
            continue
        t0 = time.time()
        model = cls.from_pretrained(BASE, subfolder=name, torch_dtype=torch.bfloat16,
                                    quantization_config=cfg)
        print(f"[{precision}] {name}: 现场量化完成 {time.time()-t0:.0f}s，开始写盘…")
        t0 = time.time()
        model.save_pretrained(dst)
        del model
        _trim()
        size = sum(f.stat().st_size for f in dst.rglob("*") if f.is_file()) / 2**30
        print(f"[{precision}] {name}: 写盘完成 {time.time()-t0:.0f}s，{size:.1f} GiB -> {dst}")
        _trim()


if __name__ == "__main__":
    which = (sys.argv[1] if len(sys.argv) > 1 else "all").lower()
    targets = ("int8", "int4") if which == "all" else (which,)
    for p in targets:
        if p not in ("int8", "int4"):
            raise SystemExit(f"未知精度: {p}（可选 int8|int4|all）")
        _export(p)
    print("全部完成")
