"""Krea 2 Turbo 管线：模型加载/卸载/精度切换 + 单线程生成 worker + LoRA 常驻管理。

- 模型在后台线程加载；加载过的 LoRA 常驻显存，只在模型页手动卸载
- 生成请求进入单线程队列（GPU 一次只跑一个任务，避免显存争抢）
- 任务状态存 TASKS，前端轮询 /api/tasks/{id}
"""

import gc
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

DEFAULT_PRECISION = "bf16"  # bf16 | int8 | int4
PRECISION_HINTS = {
    "bf16": "全精度 · 子模型按需进出显存（offload），画质无损",
    "int8": "transformer+编码器 torchao int8 · 全 GPU 常驻 ~16.7 GiB，出图约快 3 倍",
    "int4": "transformer+编码器 bnb nf4 · 全 GPU 常驻 ~9.9 GiB，最省显存，画质略降",
}

# state ∈ unloaded | loading | ready | error
MODEL_STATE = {"state": "unloaded", "detail": "未加载",
               "precision": None, "vram_gb": None}

_pipe = None
_gen_queue: "queue.Queue[dict]" = queue.Queue()
_lock = threading.Lock()  # 保护 TASKS / MODEL_STATE 的并发读写
_model_lock = threading.RLock()  # 模型与 LoRA 装卸互斥（可重入）

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


def _set_state(state: str, detail: str, **extra) -> None:
    with _lock:
        MODEL_STATE["state"] = state
        MODEL_STATE["detail"] = detail
        MODEL_STATE.update(extra)
    logger.info("model state: %s - %s %s", state, detail, extra)


# ---------------------------------------------------------------- 模型管理

def _build_pipe(precision: str):
    """按精度构建管线。量化精度（int8/int4）下 transformer 与文本编码器都量化；
    diffusers 的 pipeline.to 会跳过带量化配置的组件，所以量化路径分组件加载、
    逐个显式上 GPU。"""
    from diffusers import (BitsAndBytesConfig, Krea2Pipeline,
                           Krea2Transformer2DModel)

    if precision == "bf16":
        pipe = Krea2Pipeline.from_pretrained(MODEL_PATH, torch_dtype=torch.bfloat16)
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

    from transformers import Qwen3VLModel
    transformer = Krea2Transformer2DModel.from_pretrained(
        MODEL_PATH, subfolder="transformer", torch_dtype=torch.bfloat16,
        quantization_config=t_cfg)
    text_encoder = Qwen3VLModel.from_pretrained(
        MODEL_PATH, subfolder="text_encoder", torch_dtype=torch.bfloat16,
        quantization_config=e_cfg)
    pipe = Krea2Pipeline.from_pretrained(
        MODEL_PATH, transformer=transformer, text_encoder=text_encoder,
        torch_dtype=torch.bfloat16)
    transformer.to("cuda")
    text_encoder.to("cuda")
    pipe.vae.to("cuda")
    return pipe


def _unload_locked() -> None:
    global _pipe
    _loaded_adapters.clear()
    if _pipe is not None:
        del _pipe
        _pipe = None
        gc.collect()
        torch.cuda.empty_cache()
    _set_state("unloaded", "未加载", precision=None, vram_gb=None)


def load_model(precision: str) -> None:
    """按指定精度加载模型（调方应放到后台线程）。"""
    global _pipe
    with _model_lock:
        if MODEL_STATE["state"] == "loading":
            return
        _unload_locked()
        try:
            _set_state("loading", f"正在按 {precision} 加载（首次需几分钟）…",
                       precision=precision)
            _pipe = _build_pipe(precision)
            if precision == "bf16":
                detail = "bf16 · offload 模式（按需进出显存）"
            else:
                vram = torch.cuda.memory_allocated() / 2**30
                detail = f"{precision} · 常驻 {vram:.1f} GiB"
            _set_state("ready", detail, precision=precision,
                       vram_gb=round(vram if precision != "bf16" else 0.0, 1))
        except Exception as exc:  # noqa: BLE001 - 加载失败细节透出给前端
            logger.exception("model load failed")
            _pipe = None
            _set_state("error", f"模型加载失败：{exc}", precision=precision)


def unload_model() -> None:
    with _model_lock:
        _unload_locked()


def get_model_state() -> dict:
    with _lock:
        return dict(MODEL_STATE)


def get_precision_hints() -> dict:
    return PRECISION_HINTS


# ---------------------------------------------------------------- LoRA 管理

_lora_files: dict[str, Path] = {}  # lora_id -> 文件路径（id = sha1(文件名)[:8]）
_loaded_adapters: dict[str, str] = {}  # lora_id -> adapter_name（常驻，手动卸载才移除）


def _lora_display_name(path: Path) -> str:
    return path.stem


def list_loras() -> list[dict]:
    """扫描 loras 目录，返回 [{id, name, filename, size_mb, loaded}]。"""
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
    """加载单个 LoRA 为独立 adapter（常驻；调用方持有 _model_lock）。"""
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


def toggle_lora(lora_id: str, on: bool) -> dict:
    """模型页的加载/卸载开关：加载过的常驻，只有这里手动卸载。"""
    with _model_lock:
        if _pipe is None or MODEL_STATE["state"] != "ready":
            raise RuntimeError("模型未加载")
        if on and lora_id not in _loaded_adapters:
            _load_lora(lora_id)
        elif not on and lora_id in _loaded_adapters:
            _pipe.delete_adapters([_loaded_adapters.pop(lora_id)])
            logger.info("lora unloaded: %s", lora_id)
    return {"id": lora_id, "loaded": lora_id in _loaded_adapters}


def sync_loras(requested: list[tuple[str, float]]) -> None:
    """生成前对齐激活的 adapter：缺的补加载（常驻不卸载），并只激活本次请求的。"""
    if _pipe is None:
        return
    with _model_lock:
        for lid, _ in requested:
            if lid not in _loaded_adapters:
                _load_lora(lid)
        if requested:
            _pipe.enable_lora()
            _pipe.set_adapters(
                [_loaded_adapters[lid] for lid, _ in requested],
                adapter_weights=[weight for _, weight in requested],
            )
        else:
            _pipe.disable_lora()  # 本次不用 LoRA：全部去激活（权重保留）


# ---------------------------------------------------------------- 生成任务

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

        # 缺的 LoRA 自动补加载（常驻，不卸载）；无请求时全部去激活
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
        if MODEL_STATE["state"] != "ready" or _pipe is None:
            task = TASKS.get(req.task_id)
            if task:
                task["state"] = "error"
                task["error"] = "模型未加载，请先在「模型」页加载"
            continue
        _run_task(req)


def start_background() -> None:
    """在 FastAPI lifespan 里调用：按默认精度加载模型 + 启动生成 worker。"""
    threading.Thread(target=load_model, args=(DEFAULT_PRECISION,),
                     name="model-loader", daemon=True).start()
    threading.Thread(target=_worker, name="gen-worker", daemon=True).start()


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
