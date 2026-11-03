"""模型/LoRA 目录：由 .env / 环境变量决定（server.sh 启动时加载 .env），无 UI 修改入口。

优先级：环境变量（含 .env）> 默认值。
可配变量（见 .env.example）：
  KREA_MODELS_ROOT / KREA_MODEL_DIR / KREA_LORA_DIR
  KREA_MODEL_INT8_DIR / KREA_MODEL_INT4_DIR（预量化目录，显式指定优先于同级约定）
"""

import os
from pathlib import Path


def get_models_root() -> Path:
    return Path(os.environ.get("KREA_MODELS_ROOT", "/home/feifei/develop/models"))


def get_model_dir() -> Path:
    return Path(os.environ.get("KREA_MODEL_DIR",
                               str(get_models_root() / "Krea-2-Turbo")))


def get_lora_dir() -> Path:
    custom = os.environ.get("KREA_LORA_DIR", "")
    return Path(custom) if custom else get_model_dir() / "loras"


def _is_prequant(d: Path) -> bool:
    return (d / "transformer" / "config.json").exists() \
        and (d / "text_encoder" / "config.json").exists()


def get_quant_dir(precision: str) -> Path | None:
    """指定精度的预量化目录：显式环境变量 > 同级 -精度 约定 > None（现场量化）。
    目录须含 transformer/text_encoder 的 config.json 才算有效。"""
    explicit = os.environ.get(f"KREA_MODEL_{precision.upper()}_DIR", "")
    base = get_model_dir()
    candidates = ([Path(explicit)] if explicit else []) \
        + [base.parent / f"{base.name}-{precision}"]
    return next((d for d in candidates if _is_prequant(d)), None)
