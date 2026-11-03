"""LoRA 常驻管理：扫描目录、按 adapter 加载（默认全量常驻）、生成前对齐激活。"""

import hashlib
import logging
from pathlib import Path

from . import paths, state

logger = logging.getLogger("krea.pipeline")

_lora_files: dict[str, Path] = {}  # lora_id -> 文件路径（id = sha1(文件名)[:8]）
_loaded_adapters: dict[str, str] = {}  # lora_id -> adapter_name（常驻，手动卸载才移除）

# LoRA 默认强度：全量常驻加载时统一 0.4（前端滑杆初始值与此一致）
DEFAULT_LORA_WEIGHT = 0.4


def _lora_display_name(path: Path) -> str:
    return path.stem


def list_loras() -> list[dict]:
    """扫描 LoRA 目录（paths 配置），返回 [{id, name, filename, size_mb, loaded}]。"""
    lora_dir = paths.get_lora_dir()
    if not lora_dir.exists():
        return []
    out = []
    for p in sorted(lora_dir.glob("*.safetensors")):
        lid = hashlib.sha1(p.name.encode()).hexdigest()[:8]
        _lora_files[lid] = p
        out.append({
            "id": lid,
            "name": _lora_display_name(p),
            "filename": p.name,
            "size_mb": round(p.stat().st_size / 2**20),
            "loaded": lid in _loaded_adapters,
        })
    return out


def _merge_comfyui_alphas(state_dict: dict) -> dict:
    """kohya 系训练器把每个模块的 alpha 存成独立标量，diffusers 的
    Krea2 转换器只认 lora_A/B 对、见到剩余 key 会 raise。数学等价处理：
    scale = alpha / rank，预乘进 lora_B 后丢弃 alpha。"""
    for key in [k for k in list(state_dict) if k.endswith(".alpha")]:
        module = key[: -len(".alpha")]
        lora_a = f"{module}.lora_A.weight"
        lora_b = f"{module}.lora_B.weight"
        if lora_a not in state_dict or lora_b not in state_dict:
            state_dict.pop(key)
            continue
        rank = state_dict[lora_a].shape[0]
        alpha = state_dict.pop(key).item()
        state_dict[lora_b] = state_dict[lora_b] * (alpha / rank)
    return state_dict


def _load_lora(lora_id: str) -> None:
    """加载单个 LoRA 为独立 adapter（常驻；调用方持有 model_lock）。"""
    from safetensors.torch import load_file

    path = _lora_files.get(lora_id)
    if path is None:
        raise ValueError(f"未知 LoRA: {lora_id}")
    adapter_name = f"lora_{lora_id}"
    sd = load_file(str(path))
    # ComfyUI 格式（diffusion_model. 前缀 + alpha 标量）需要先合并 alpha
    if any(k.startswith("diffusion_model.") for k in sd):
        sd = _merge_comfyui_alphas(sd)
    state.pipe.load_lora_weights(sd, adapter_name=adapter_name)
    _loaded_adapters[lora_id] = adapter_name
    logger.info("lora loaded: %s (%s)", path.name, lora_id)


def _load_all_loras_locked() -> None:
    """模型加载完成后把 loras 目录的 LoRA 全部装为常驻 adapter，
    并统一按 DEFAULT_LORA_WEIGHT（0.4）激活（生成请求会按前端权重重设）。
    单个失败只告警不阻断模型加载；调用方持有 model_lock。"""
    list_loras()  # 刷新 _lora_files
    for lid, path in list(_lora_files.items()):
        if lid in _loaded_adapters:
            continue
        try:
            _load_lora(lid)
        except Exception as exc:  # noqa: BLE001 - 单个 LoRA 损坏不影响其余
            logger.warning("lora auto-load failed: %s - %s", path.name, exc)
    if _loaded_adapters:
        state.pipe.enable_lora()
        state.pipe.set_adapters(list(_loaded_adapters.values()),
                                adapter_weights=[DEFAULT_LORA_WEIGHT] * len(_loaded_adapters))
        logger.info("lora activated: %d adapters @ %.2f",
                    len(_loaded_adapters), DEFAULT_LORA_WEIGHT)


def toggle_lora(lora_id: str, on: bool) -> dict:
    """模型页的加载/卸载开关：加载过的常驻，只有这里手动卸载。
    生成/换精度进行中（锁被占）直接 409 拒绝，不挂死请求。"""
    if not state.model_lock.acquire(timeout=2.0):
        raise RuntimeError("模型忙（生成或换精度中），稍后再试")
    try:
        if state.pipe is None or state.MODEL_STATE["state"] != "ready":
            raise RuntimeError("模型未加载")
        if on and lora_id not in _loaded_adapters:
            _load_lora(lora_id)
        elif not on and lora_id in _loaded_adapters:
            state.pipe.delete_adapters([_loaded_adapters.pop(lora_id)])
            logger.info("lora unloaded: %s", lora_id)
    finally:
        state.model_lock.release()
    return {"id": lora_id, "loaded": lora_id in _loaded_adapters}


def sync_loras(requested: list[tuple[str, float]]) -> None:
    """生成前对齐激活的 adapter：缺的补加载（常驻不卸载），并只激活本次请求的。"""
    if state.pipe is None:
        return
    with state.model_lock:
        for lid, _ in requested:
            if lid not in _loaded_adapters:
                _load_lora(lid)
        if requested:
            state.pipe.enable_lora()
            state.pipe.set_adapters(
                [_loaded_adapters[lid] for lid, _ in requested],
                adapter_weights=[weight for _, weight in requested],
            )
        else:
            state.pipe.disable_lora()  # 本次不用 LoRA：全部去激活（权重保留）
