"""模型/LoRA 目录与 API 密钥：由 .env / 环境变量决定（server.sh 启动时加载 .env），无 UI 修改入口。

KREA_MODEL_DIR 必填（无默认值——避免把开发者的个人路径带进仓库）；
未配置时 fail-fast 并给出可操作的指引。
可配变量（见 .env.example）：KREA_MODEL_DIR（必填）/ KREA_LORA_DIR（可选）/
KREA_MODEL_INT8_DIR / KREA_MODEL_INT4_DIR（预量化目录，可选）/ KREA_API_KEY（必填）
"""

import os
from pathlib import Path


class ModelDirNotConfigured(RuntimeError):
    """KREA_MODEL_DIR 未配置。"""


class ApiKeyNotConfigured(RuntimeError):
    """KREA_API_KEY 未配置。"""


def get_api_key() -> str:
    k = os.environ.get("KREA_API_KEY", "").strip()
    if not k:
        raise ApiKeyNotConfigured(
            "未配置 API 密钥：在 .env 设置 KREA_API_KEY"
            "（可用 `openssl rand -hex 16` 生成）后重启")
    return k


def get_model_dir() -> Path:
    d = os.environ.get("KREA_MODEL_DIR", "").strip()
    if not d:
        raise ModelDirNotConfigured(
            "未配置模型目录：复制 .env.example 为 .env，设置 KREA_MODEL_DIR 后重启")
    return Path(d)


def get_lora_dir() -> Path:
    custom = os.environ.get("KREA_LORA_DIR", "").strip()
    return Path(custom) if custom else get_model_dir() / "loras"


def get_lora_autoload() -> bool:
    """启动时是否自动装载 LoRA（默认开）。没有 LoRA 或不想常驻时设 0 关闭。"""
    return os.environ.get("KREA_LORA_AUTLOAD", "1").strip() not in ("0", "false", "no")


def _is_prequant(d: Path) -> bool:
    return (d / "transformer" / "config.json").exists() \
        and (d / "text_encoder" / "config.json").exists()


def get_quant_dir(precision: str) -> Path | None:
    """指定精度的预量化目录：显式环境变量 > 同级 -精度 约定 > None（现场量化）。
    目录须含 transformer/text_encoder 的 config.json 才算有效。"""
    explicit = os.environ.get(f"KREA_MODEL_{precision.upper()}_DIR", "").strip()
    base = get_model_dir()
    candidates = ([Path(explicit)] if explicit else []) \
        + [base.parent / f"{base.name}-{precision}"]
    return next((d for d in candidates if _is_prequant(d)), None)
