"""量化加载实测：int8 / int4 全 GPU 常驻 vs bf16+offload。

验证：bnb 量化在 5090 (sm_120) 上能否加载、生成、挂 LoRA；显存与速度。

用法：.venv/bin/python scripts/quant_probe.py [int8|int4]
"""

import gc
import sys
import time
from pathlib import Path

import torch
from safetensors.torch import load_file

MODEL_PATH = Path("/home/feifei/develop/models/Krea-2-Turbo")
LORA_DIR = MODEL_PATH / "loras"
OUT = Path(__file__).resolve().parent.parent / "outputs"


def merge_comfyui_alphas(state_dict: dict) -> dict:
    for key in [k for k in list(state_dict) if k.endswith(".alpha")]:
        module = key[: -len(".alpha")]
        a, b = f"{module}.lora_A.weight", f"{module}.lora_B.weight"
        if a in state_dict and b in state_dict:
            alpha = state_dict.pop(key).item()
            state_dict[b] = state_dict[b] * (alpha / state_dict[a].shape[0])
        else:
            state_dict.pop(key)
    return state_dict


def probe(precision: str) -> None:
    from diffusers import (BitsAndBytesConfig, Krea2Pipeline,
                           Krea2Transformer2DModel, PipelineQuantizationConfig)

    t0 = time.time()
    if precision == "int8":          # bitsandbytes int8
        t_cfg = BitsAndBytesConfig(load_in_8bit=True)
    elif precision == "int4":        # bitsandbytes nf4
        t_cfg = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                                   bnb_4bit_compute_dtype=torch.bfloat16)
    elif precision == "int8ao":      # torchao weight-only int8
        from diffusers import TorchAoConfig
        from torchao.quantization import Int8WeightOnlyConfig
        t_cfg = TorchAoConfig(Int8WeightOnlyConfig())
    elif precision == "int4ao":      # torchao weight-only int4
        from diffusers import TorchAoConfig
        from torchao.quantization import Int4WeightOnlyConfig
        t_cfg = TorchAoConfig(Int4WeightOnlyConfig())
    elif precision == "int8full":    # torchao int8：transformer + 文本编码器都量化
        from diffusers import TorchAoConfig
        from torchao.quantization import Int8WeightOnlyConfig
        t_cfg = TorchAoConfig(Int8WeightOnlyConfig())
        e_cfg = TorchAoConfig(Int8WeightOnlyConfig())
    elif precision == "int4full":    # bnb nf4：transformer + 文本编码器都量化
        t_cfg = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                                   bnb_4bit_compute_dtype=torch.bfloat16)
        e_cfg = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                                   bnb_4bit_compute_dtype=torch.bfloat16)
    else:
        raise ValueError(precision)
    # transformer 必量化；int8full/int4full 连文本编码器一起量化。
    # pipeline 级 quant_mapping 对 transformers 文本编码器有集成兼容问题，
    # 改分组件加载：transformer 走 diffusers config，text_encoder 走 transformers 原生 config。
    if precision in ("int8full", "int4full"):
        from transformers import Qwen3VLModel
        if precision == "int8full":
            from transformers import TorchAoConfig as HFTorchAoConfig
            from torchao.quantization import Int8WeightOnlyConfig as HFInt8
            e_cfg = HFTorchAoConfig(HFInt8())
        else:
            from transformers import BitsAndBytesConfig as HFBnbConfig
            e_cfg = HFBnbConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                                bnb_4bit_compute_dtype=torch.bfloat16)
        transformer = Krea2Transformer2DModel.from_pretrained(
            MODEL_PATH, subfolder="transformer", torch_dtype=torch.bfloat16,
            quantization_config=t_cfg)
        text_encoder = Qwen3VLModel.from_pretrained(
            MODEL_PATH, subfolder="text_encoder", torch_dtype=torch.bfloat16,
            quantization_config=e_cfg)
        pipe = Krea2Pipeline.from_pretrained(
            MODEL_PATH, transformer=transformer, text_encoder=text_encoder,
            torch_dtype=torch.bfloat16)
        # diffusers 的 pipeline.to 会跳过带量化配置的组件，逐个显式上 GPU
        transformer.to("cuda")
        text_encoder.to("cuda")
        pipe.vae.to("cuda")
    else:
        qcfg = PipelineQuantizationConfig(quant_mapping={"transformer": t_cfg})
        pipe = Krea2Pipeline.from_pretrained(
            MODEL_PATH, torch_dtype=torch.bfloat16, quantization_config=qcfg)
        pipe.to("cuda")  # 量化后全量常驻，无需 offload
    torch.cuda.reset_peak_memory_stats()
    print(f"[{time.time()-t0:6.1f}s] loaded, VRAM {torch.cuda.memory_allocated()/2**30:.1f} GiB")

    generator = torch.Generator(device="cuda").manual_seed(7)
    img = pipe("a cozy reading nook by a rainy window, warm lamp light",
               width=512, height=512, num_inference_steps=8,
               guidance_scale=0.0, generator=generator).images[0]
    img.save(OUT / f"quant_{precision}.jpg", quality=95)
    print(f"[{time.time()-t0:6.1f}s] generated, VRAM peak {torch.cuda.max_memory_allocated()/2**30:.1f} GiB")

    # LoRA 组合验证（diffusers 格式 + ComfyUI 格式各一）
    pipe.load_lora_weights(str(LORA_DIR / "FeiFei_c1-st2000.safetensors"), adapter_name="feifei")
    sd = merge_comfyui_alphas(load_file(str(LORA_DIR / "krea2-Cc风情万种-风格.safetensors")))
    pipe.load_lora_weights(sd, adapter_name="cc_style")
    pipe.set_adapters(["feifei", "cc_style"], adapter_weights=[0.8, 1.2])
    generator = torch.Generator(device="cuda").manual_seed(7)
    img = pipe("a cozy reading nook by a rainy window, warm lamp light",
               width=512, height=512, num_inference_steps=8,
               guidance_scale=0.0, generator=generator).images[0]
    img.save(OUT / f"quant_{precision}_lora.jpg", quality=95)
    print(f"[{time.time()-t0:6.1f}s] lora ok, VRAM peak {torch.cuda.max_memory_allocated()/2**30:.1f} GiB")

    del pipe
    gc.collect()
    torch.cuda.empty_cache()
    print(f"[{time.time()-t0:6.1f}s] {precision} done & freed")


if __name__ == "__main__":
    for p in (sys.argv[1:] or ["int8", "int4"]):
        try:
            probe(p)
        except Exception as exc:  # noqa: BLE001 - 单个精度失败不影响下一个
            import traceback
            print(f"!! {p} FAILED: {exc}")
            traceback.print_exc(limit=3)
            gc.collect()
            torch.cuda.empty_cache()
