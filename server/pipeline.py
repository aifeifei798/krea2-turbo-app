"""Krea 2 Turbo 管线：后台加载 + 单线程生成 worker + 任务状态。

- 模型在后台线程加载，加载阶段通过 MODEL 状态暴露给 /api/status
- 生成请求进入单线程队列（GPU 一次只跑一个任务，避免显存争抢）
- 任务状态存 TASKS，前端轮询 /api/tasks/{id}
"""

import hashlib
import json
import logging
import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import torch

from .presets import DEFAULT_STEPS, get_aspect, get_style

logger = logging.getLogger("krea.pipeline")

BASE_DIR = Path(__file__).resolve().parent.parent
MODEL_PATH = Path("/home/feifei/develop/models/Krea-2-Turbo")
LORA_DIR = MODEL_PATH / "loras"
OUTPUT_DIR = BASE_DIR / "outputs"

# 加载状态：state ∈ loading | ready | error；detail 给前端展示
LOAD_STATE = {"state": "loading", "detail": "正在初始化…"}

_pipe = None
_gen_queue: "queue.Queue[dict]" = queue.Queue()
_lock = threading.Lock()  # 保护 TASKS / LOAD_STATE 的并发读写

TASKS: dict[str, dict] = {}
TASK_TTL = 3600  # 完成任务保留 1 小时供前端查询


@dataclass
class GenRequest:
    task_id: str
    prompt: str
    style_id: str
    aspect_id: str
    steps: int
    seed: int | None
    batch: int
    loras: list[tuple[str, float]] = field(default_factory=list)  # (lora_id, weight)
    created_at: float = field(default_factory=time.time)


def _set_load(state: str, detail: str) -> None:
    with _lock:
        LOAD_STATE["state"] = state
        LOAD_STATE["detail"] = detail
    logger.info("load state: %s - %s", state, detail)


def _load_model() -> None:
    """后台加载模型。32GB 显存对 12B DiT + Qwen3-VL 文本编码器偏紧，
    用 enable_model_cpu_offload()：推理时只有当前子模型驻留 GPU。"""
    global _pipe
    try:
        from diffusers import Krea2Pipeline

        _set_load("loading", "正在加载管线组件（约 58GB，首次需几分钟）…")
        _pipe = Krea2Pipeline.from_pretrained(MODEL_PATH, torch_dtype=torch.bfloat16)
        _set_load("loading", "正在分配显存（模型 CPU offload）…")
        _pipe.enable_model_cpu_offload()
        # 蒸馏模型固定关闭 CFG；推理函数关闭
        _set_load("ready", "模型就绪")
    except Exception as exc:  # noqa: BLE001 - 加载失败细节必须透出给前端
        logger.exception("model load failed")
        _set_load("error", f"模型加载失败：{exc}")


def _new_task(req: GenRequest) -> dict:
    style = get_style(req.style_id)
    aspect = get_aspect(req.aspect_id)
    all_loras = {l["id"]: l for l in list_loras()}
    return {
        "task_id": req.task_id,
        "state": "queued",
        "step": 0,
        "total_steps": req.steps,
        "error": None,
        "images": [],
        "request": {
            "prompt": req.prompt,
            "style_id": style["id"],
            "style_name": style["name"],
            "aspect_id": aspect["id"],
            "width": aspect["width"],
            "height": aspect["height"],
            "steps": req.steps,
            "seed": req.seed,
            "batch": req.batch,
            "loras": [
                {"id": lid, "name": all_loras[lid]["name"], "weight": weight}
                for lid, weight in req.loras if lid in all_loras
            ],
        },
    }


def _prune_tasks() -> None:
    now = time.time()
    for tid in [t for t, v in TASKS.items() if v["state"] in ("done", "error")
                and now - v.get("finished_at", 0) > TASK_TTL]:
        TASKS.pop(tid, None)


def _save_image(image, task: dict, seed: int, index: int) -> dict:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d_%H%M%S")
    stem = f"{ts}_{seed}_{index}" if task["request"]["batch"] > 1 else f"{ts}_{seed}"
    jpg_path = OUTPUT_DIR / f"{stem}.jpg"
    image.save(jpg_path, quality=95)

    meta = {
        "id": stem,
        "prompt": task["request"]["prompt"],
        "style_id": task["request"]["style_id"],
        "style_name": task["request"]["style_name"],
        "aspect_id": task["request"]["aspect_id"],
        "width": task["request"]["width"],
        "height": task["request"]["height"],
        "steps": task["request"]["steps"],
        "seed": seed,
        "loras": task["request"]["loras"],
        "created_at": int(time.time()),
        "model": "Krea 2 Turbo",
    }
    (OUTPUT_DIR / f"{stem}.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    return {"id": stem, "url": f"/outputs/{stem}.jpg", **{k: meta[k] for k in
            ("prompt", "style_name", "width", "height", "steps", "seed", "loras", "created_at")}}


def _run_task(req: GenRequest) -> None:
    task = TASKS.get(req.task_id)
    if task is None:
        return
    task["state"] = "running"
    try:
        full_prompt = req.prompt.strip()
        suffix = get_style(req.style_id)["suffix"]
        if suffix:
            full_prompt = f"{full_prompt}, {suffix}"

        # 按本次请求对齐 LoRA（首次启用某 LoRA 会有几秒加载时间）
        if req.loras:
            task["step"] = 0
            task["total_steps"] = req.steps
            sync_loras(req.loras)

        seed = req.seed if req.seed is not None else torch.randint(
            0, 2**31 - 1, (1,)).item()
        task["request"]["seed"] = seed

        def on_step(pipeline, step_index, timestep, kwargs):
            task["step"] = step_index + 1
            return kwargs

        generator = torch.Generator(device="cuda").manual_seed(seed)
        result = _pipe(
            prompt=full_prompt,
            width=task["request"]["width"],
            height=task["request"]["height"],
            num_inference_steps=req.steps,
            guidance_scale=0.0,  # 蒸馏模型：CFG 关闭，负面提示词无效
            num_images_per_prompt=req.batch,
            generator=generator,
            callback_on_step_end=on_step,
        )
        for i, image in enumerate(result.images):
            task["images"].append(_save_image(image, task, seed, i))
        task["state"] = "done"
    except Exception as exc:  # noqa: BLE001 - 生成失败细节透出给前端
        logger.exception("generation failed")
        task["state"] = "error"
        task["error"] = str(exc)
    finally:
        task["finished_at"] = time.time()
        with _lock:
            _prune_tasks()


def _worker() -> None:
    while True:
        req = _gen_queue.get()
        if LOAD_STATE["state"] != "ready" or _pipe is None:
            task = TASKS.get(req.task_id)
            if task:
                task["state"] = "error"
                task["error"] = "模型未就绪"
            continue
        _run_task(req)


def start_background() -> None:
    """在 FastAPI lifespan 里调用：启动加载线程 + 生成 worker。"""
    threading.Thread(target=_load_model, name="model-loader", daemon=True).start()
    threading.Thread(target=_worker, name="gen-worker", daemon=True).start()


def get_load_state() -> dict:
    with _lock:
        return dict(LOAD_STATE)


# ---------------------------------------------------------------- LoRA 管理

_lora_files: dict[str, Path] = {}  # lora_id -> 文件路径（id = sha1(文件名)[:8]）
_loaded_adapters: dict[str, str] = {}  # lora_id -> adapter_name（当前驻留 GPU 注入的）


def _lora_display_name(path: Path) -> str:
    return path.stem


def list_loras() -> list[dict]:
    """扫描 loras 目录，返回 [{id, name, filename, size_mb}]。"""
    if not LORA_DIR.exists():
        return []
    out = []
    for p in sorted(LORA_DIR.glob("*.safetensors")):
        lid = hashlib.sha1(p.name.encode()).hexdigest()[:8]
        _lora_files[lid] = p
        out.append({
            "id": lid,
            "name": _lora_display_name(p),
            "filename": p.name,
            "size_mb": round(p.stat().st_size / 2**20),
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
    """加载单个 LoRA 为独立 adapter。"""
    from safetensors.torch import load_file

    path = _lora_files.get(lora_id)
    if path is None:
        raise ValueError(f"未知 LoRA: {lora_id}")
    adapter_name = f"lora_{lora_id}"
    sd = load_file(str(path))
    # ComfyUI 格式（diffusion_model. 前缀 + alpha 标量）需要先合并 alpha
    if any(k.startswith("diffusion_model.") for k in sd):
        sd = _merge_comfyui_alphas(sd)
    _pipe.load_lora_weights(sd, adapter_name=adapter_name)
    _loaded_adapters[lora_id] = adapter_name
    logger.info("lora loaded: %s (%s)", path.name, lora_id)


def sync_loras(requested: list[tuple[str, float]]) -> None:
    """按本次请求对齐已加载 adapter 集合与权重，多余的被支持后可复用。"""
    if _pipe is None:
        return
    wanted_ids = [lid for lid, _ in requested]
    # 卸载不再使用的
    stale = [lid for lid in _loaded_adapters if lid not in wanted_ids]
    if stale:
        _pipe.delete_adapters([_loaded_adapters.pop(lid) for lid in stale])
        logger.info("lora unloaded: %s", stale)
    # 加载新出现的
    for lid in wanted_ids:
        if lid not in _loaded_adapters:
            _load_lora(lid)
    # 设置权重（diffusers 的 set_adapters 传空列表会报错，跳过）
    if requested:
        _pipe.set_adapters(
            [_loaded_adapters[lid] for lid, _ in requested],
            adapter_weights=[weight for _, weight in requested],
        )


def enqueue(prompt: str, style_id: str, aspect_id: str, steps: int,
            seed: int | None, batch: int,
            loras: list[tuple[str, float]] | None = None) -> str:
    req = GenRequest(
        task_id=uuid.uuid4().hex[:12],
        prompt=prompt,
        style_id=style_id,
        aspect_id=aspect_id,
        steps=steps,
        seed=seed,
        batch=batch,
        loras=loras or [],
    )
    with _lock:
        TASKS[req.task_id] = _new_task(req)
        _prune_tasks()
    _gen_queue.put(req)
    return req.task_id


def get_task(task_id: str) -> dict | None:
    with _lock:
        task = TASKS.get(task_id)
        return json.loads(json.dumps(task)) if task else None  # 快照拷贝
