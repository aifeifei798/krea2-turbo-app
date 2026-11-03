"""模型管理：按精度构建/加载/卸载 Krea2 管线（bf16 offload 与 int8/int4 量化）。"""

import gc
import logging
import os
from pathlib import Path

import torch

from . import lora, paths, state

logger = logging.getLogger("krea.pipeline")

_PRECISIONS = ("bf16", "int8", "int4")


def _quant_source(precision: str) -> Path:
    """该精度实际读取的目录：预量化目录（显式指定 > 同级约定）> 模型目录（现场量化）。"""
    return paths.get_quant_dir(precision) or paths.get_model_dir()

# 启动精度可用环境变量指定：KREA_PRECISION=bf16|int8|int4（server.sh 传入），默认 int8
DEFAULT_PRECISION = os.environ.get("KREA_PRECISION", "int8").strip().lower()
if DEFAULT_PRECISION not in _PRECISIONS:
    logger.warning("KREA_PRECISION=%s 无效，回退 int8（可选 %s）",
                   DEFAULT_PRECISION, "/".join(_PRECISIONS))
    DEFAULT_PRECISION = "int8"
PRECISION_HINTS = {
    "bf16": "全精度 · offload 模式，权重需 ~58GB 磁盘换页缓冲（RAM 紧张慎用），画质无损",
    "int8": "transformer+编码器 torchao int8 · 全 GPU 常驻 ~16.7 GiB，出图约快 3 倍",
    "int4": "transformer+编码器 bnb nf4 · 全 GPU 常驻 ~9.9 GiB，最省显存，画质略降",
}


def _build_pipe(precision: str):
    """按精度构建管线。量化精度（int8/int4）下 transformer 与文本编码器都量化；
    diffusers 的 pipeline.to 会跳过带量化配置的组件，所以量化路径分组件加载、
    逐个显式上 GPU。模型目录取自 paths 配置（模型页可切换）。"""
    from diffusers import (BitsAndBytesConfig, Krea2Pipeline,
                           Krea2Transformer2DModel)

    md = paths.get_model_dir()
    if precision == "bf16":
        pipe = Krea2Pipeline.from_pretrained(md, torch_dtype=torch.bfloat16)
        # 32GB 显存对 bf16 全量偏紧，offload 让子模型按需进出
        pipe.enable_model_cpu_offload()
        return pipe

    if precision == "int8":
        # torchao int8wo（bnb int8 与 torch 2.15 有 kernel 兼容 bug，实测失败）
        from diffusers import TorchAoConfig
        from torchao.quantization import Int8WeightOnlyConfig
        t_cfg = TorchAoConfig(Int8WeightOnlyConfig())
        # 文本编码器走 transformers 加载路径，量化配置必须用 transformers 的类
        from transformers import TorchAoConfig as HFTorchAoConfig
        e_cfg = HFTorchAoConfig(Int8WeightOnlyConfig())
    elif precision == "int4":
        # bnb nf4：实测显存最低（9.9 GiB 常驻）且与 LoRA 兼容
        t_cfg = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                                   bnb_4bit_compute_dtype=torch.bfloat16)
        from transformers import BitsAndBytesConfig as HFBnbConfig
        e_cfg = HFBnbConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                            bnb_4bit_compute_dtype=torch.bfloat16)
    else:
        raise ValueError(f"未知精度: {precision}")

    # 预量化目录存在时直读（量化配置已嵌在组件 config.json 里，勿重复传）
    src = _quant_source(precision)
    prequant = src != md
    from transformers import Qwen3VLModel
    if prequant:
        logger.info("precision %s: 读取预量化权重 %s", precision, src)
        transformer = Krea2Transformer2DModel.from_pretrained(
            src, subfolder="transformer", torch_dtype=torch.bfloat16)
        text_encoder = Qwen3VLModel.from_pretrained(
            src, subfolder="text_encoder", torch_dtype=torch.bfloat16)
    else:
        transformer = Krea2Transformer2DModel.from_pretrained(
            md, subfolder="transformer", torch_dtype=torch.bfloat16,
            quantization_config=t_cfg)
        text_encoder = Qwen3VLModel.from_pretrained(
            md, subfolder="text_encoder", torch_dtype=torch.bfloat16,
            quantization_config=e_cfg)
    pipe = Krea2Pipeline.from_pretrained(
        md, transformer=transformer, text_encoder=text_encoder,
        torch_dtype=torch.bfloat16)
    transformer.to("cuda")
    text_encoder.to("cuda")
    pipe.vae.to("cuda")
    return pipe


def _malloc_trim() -> None:
    """把 glibc 分配器滞留的空闲内存归还 OS。

    模型加载/卸载涉及数十 GB 的大块分配，glibc 默认不归还，
    多次切换精度后 RSS 只涨不跌，最终把 32GB RAM 吃满触发 OOM。"""
    try:
        import ctypes
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:  # noqa: BLE001 - 非 glibc 平台没有这个接口，忽略
        pass


def _unload_locked() -> None:
    lora._loaded_adapters.clear()
    if state.pipe is not None:
        state.pipe = None
        gc.collect()
        torch.cuda.empty_cache()
        _malloc_trim()
    state.set_state("unloaded", "未加载", precision=None, vram_gb=None)


def load_model(precision: str) -> None:
    """按指定精度加载模型，随后全量常驻加载 LoRA（调方应放到后台线程）。"""
    with state.model_lock:
        if state.MODEL_STATE["state"] == "loading":
            return
        _unload_locked()
        try:
            state.set_state("loading", f"正在按 {precision} 加载（首次需几分钟）…",
                            precision=precision)
            state.pipe = _build_pipe(precision)
            gc.collect()
            _malloc_trim()
            if paths.get_lora_autoload():
                lora._load_all_loras_locked()  # 默认全量常驻；KREA_LORA_AUTLOAD=0 关闭
            if precision == "bf16":
                detail = "bf16 · offload 模式（按需进出显存）"
            else:
                vram = torch.cuda.memory_allocated() / 2**30
                detail = f"{precision} · 常驻 {vram:.1f} GiB"
            state.set_state("ready", detail, precision=precision,
                            vram_gb=round(vram if precision != "bf16" else 0.0, 1))
        except Exception as exc:  # noqa: BLE001 - 加载失败细节透出给前端
            logger.exception("model load failed")
            state.pipe = None
            state.set_state("error", f"模型加载失败：{exc}", precision=precision)


def unload_model() -> None:
    with state.model_lock:
        _unload_locked()


def get_model_state() -> dict:
    with state.lock:
        return dict(state.MODEL_STATE)


def get_precision_hints() -> dict:
    return PRECISION_HINTS
