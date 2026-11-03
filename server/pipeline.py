"""Krea 2 Turbo 管线：模型加载/卸载/精度切换 + 单线程生成 worker + LoRA 常驻管理。

- 模型在后台线程加载；加载完成后 loras 目录的 LoRA 默认全部装为常驻
  adapter（强度默认 0.4），只在模型页手动卸载
- 生成请求进入单线程队列（GPU 一次只跑一个任务，避免显存争抢）
- 任务状态存 TASKS，前端轮询 /api/tasks/{id}
"""

import gc
import hashlib
import json
import logging
import os
import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import torch

from .presets import DEFAULT_STEPS, get_aspect, get_style

logger = logging.getLogger("krea.pipeline")

BASE_DIR = Path(__file__).resolve().parent.parent
MODEL_PATH = Path("/home/feifei/develop/models/Krea-2-Turbo")
LORA_DIR = MODEL_PATH / "loras"
OUTPUT_DIR = BASE_DIR / "outputs"

_PRECISIONS = ("bf16", "int8", "int4")

# 预量化模型目录（scripts/export_quantized.py 生成）：存在则直读量化权重，
# 省一半/四分之三读盘并免现场量化；缺失则回退从主目录现场量化（行为不变）
QUANT_MODEL_DIRS = {
    "int8": MODEL_PATH.parent / f"{MODEL_PATH.name}-int8",
    "int4": MODEL_PATH.parent / f"{MODEL_PATH.name}-int4",
}


def _quant_source(precision: str) -> Path:
    """该精度应读取的 transformer/text_encoder 所在目录。"""
    d = QUANT_MODEL_DIRS.get(precision)
    if d and (d / "transformer" / "config.json").exists() \
            and (d / "text_encoder" / "config.json").exists():
        return d
    return MODEL_PATH
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
    rounds: int = 1  # 跑几轮：每轮独立管线调用（batch 张/轮），种子逐轮 +1
    init_image: str | None = None  # base64 参考图（有值 = 图生图重绘）
    strength: float = 0.6  # 重绘幅度 0-1：越大越偏离原图
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

    # 预量化目录存在时直读（量化配置已嵌在组件 config.json 里，勿重复传）
    src = _quant_source(precision)
    prequant = src is not MODEL_PATH
    from transformers import Qwen3VLModel
    if prequant:
        logger.info("precision %s: 读取预量化权重 %s", precision, src)
        transformer = Krea2Transformer2DModel.from_pretrained(
            src, subfolder="transformer", torch_dtype=torch.bfloat16)
        text_encoder = Qwen3VLModel.from_pretrained(
            src, subfolder="text_encoder", torch_dtype=torch.bfloat16)
    else:
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
    global _pipe
    _loaded_adapters.clear()
    if _pipe is not None:
        del _pipe
        _pipe = None
        gc.collect()
        torch.cuda.empty_cache()
        _malloc_trim()
    _set_state("unloaded", "未加载", precision=None, vram_gb=None)


def load_model(precision: str) -> None:
    """按指定精度加载模型，随后全量常驻加载 LoRA（调方应放到后台线程）。"""
    global _pipe
    with _model_lock:
        if MODEL_STATE["state"] == "loading":
            return
        _unload_locked()
        try:
            _set_state("loading", f"正在按 {precision} 加载（首次需几分钟）…",
                       precision=precision)
            _pipe = _build_pipe(precision)
            gc.collect()
            _malloc_trim()
            _load_all_loras_locked()  # LoRA 默认全量常驻（详见 _load_all_loras_locked）
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

# LoRA 默认强度：全量常驻加载时统一 0.4（前端滑杆初始值与此一致）
DEFAULT_LORA_WEIGHT = 0.4


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


def _load_all_loras_locked() -> None:
    """模型加载完成后把 loras 目录的 LoRA 全部装为常驻 adapter，
    并统一按 DEFAULT_LORA_WEIGHT（0.4）激活（生成请求会按前端权重重设）。
    单个失败只告警不阻断模型加载；调用方持有 _model_lock。"""
    list_loras()  # 刷新 _lora_files
    for lid, path in list(_lora_files.items()):
        if lid in _loaded_adapters:
            continue
        try:
            _load_lora(lid)
        except Exception as exc:  # noqa: BLE001 - 单个 LoRA 损坏不影响其余
            logger.warning("lora auto-load failed: %s - %s", path.name, exc)
    if _loaded_adapters:
        _pipe.enable_lora()
        _pipe.set_adapters(list(_loaded_adapters.values()),
                           adapter_weights=[DEFAULT_LORA_WEIGHT] * len(_loaded_adapters))
        logger.info("lora activated: %d adapters @ %.2f",
                    len(_loaded_adapters), DEFAULT_LORA_WEIGHT)


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


# ---------------------------------------------------------------- SDEdit 图生图（重绘）

def _decode_image_b64(b64: str):
    """接受裸 base64 或 data URL，返回 RGB PIL Image；非法输入抛异常。"""
    import base64
    import io

    from PIL import Image
    if b64.startswith("data:"):
        b64 = b64.split(",", 1)[-1]
    img = Image.open(io.BytesIO(base64.b64decode(b64, validate=True)))
    return img.convert("RGB")


def _prepare_init_tensor(img, width: int, height: int) -> torch.Tensor:
    """参考图中心裁剪到目标比例、缩放到目标尺寸（均为 16 的倍数对齐），
    返回 (1,3,1,H,W)、[-1,1] 的 bf16 张量。"""
    import numpy as np

    from PIL import Image
    scale = max(width / img.width, height / img.height)
    nw, nh = round(img.width * scale), round(img.height * scale)
    img = img.resize((nw, nh), Image.LANCZOS)
    left, top = (nw - width) // 2, (nh - height) // 2
    img = img.crop((left, top, left + width, top + height))
    arr = torch.from_numpy(np.asarray(img).copy()).permute(2, 0, 1)[None, :, None]
    return arr.to(torch.bfloat16) / 127.5 - 1.0


@torch.no_grad()
def _encode_init_latents(b64: str, width: int, height: int, batch: int) -> torch.Tensor:
    """参考图 → 模型空间的初始潜变量（已 pack、未加噪）(batch, seq, ch*p*p)。
    编码约定与 QwenImage 官方管线一致：z.mode() 后 (z - mean) / std。
    必须 no_grad：否则 Wan VAE 编码的激活图全被 autograd 扣住直接 OOM。
    调用方持有 _model_lock。"""
    x = _prepare_init_tensor(_decode_image_b64(b64), width, height).to(_pipe._execution_device)
    vae = _pipe.vae
    z = vae.encode(x).latent_dist.mode()  # (1, z_dim, 1, h, w)，取确定性 mode
    mean = torch.tensor(vae.config.latents_mean, device=z.device, dtype=z.dtype).view(1, -1, 1, 1, 1)
    std = torch.tensor(vae.config.latents_std, device=z.device, dtype=z.dtype).view(1, -1, 1, 1, 1)
    x0 = ((z - mean) / std)[:, :, 0]  # 去时间维 → (1, ch, h, w)
    lh, lw = height // _pipe.vae_scale_factor, width // _pipe.vae_scale_factor
    ch = _pipe.transformer.config.in_channels // (_pipe.patch_size ** 2)
    packed = _pipe._pack_latents(x0, 1, ch, lh, lw)
    return packed.expand(batch, -1, -1)


def _img2img_schedule(steps: int, strength: float) -> tuple[list[float], int]:
    """SDEdit 截断：按幅度跳过前段 sigma，返回 (原始线性 sigmas, 实际去噪步数)。"""
    actual = max(1, round(steps * (1.0 - strength)))
    raw = np.linspace(1.0, 1.0 / steps, steps)[steps - actual:].tolist()
    return raw, actual


def _dynamic_shift_mu(seq_len: int) -> float:
    """非蒸馏权重的分辨率感知 shift（与管线 calculate_shift 一致）；蒸馏权重固定 1.15。"""
    cfg = _pipe.scheduler.config
    base_seq = cfg.get("base_image_seq_len", 256)
    max_seq = cfg.get("max_image_seq_len", 6400)
    base_shift = cfg.get("base_shift", 0.5)
    max_shift = cfg.get("max_shift", 1.15)
    return base_shift + (max_shift - base_shift) * (seq_len - base_seq) / (max_seq - base_seq)


# ---------------------------------------------------------------- 生成任务

def _new_task(req: GenRequest) -> dict:
    style = get_style(req.style_id)
    aspect = get_aspect(req.aspect_id)
    all_loras = {l["id"]: l for l in list_loras()}
    is_i2i = bool(req.init_image)
    # 重绘按幅度跳过前段 sigma，每轮实际去噪步数变少（进度条按真实步数计）
    steps_per_round = _img2img_schedule(req.steps, req.strength)[1] if is_i2i else req.steps
    return {
        "task_id": req.task_id,
        "state": "queued",
        "step": 0,
        "total_steps": steps_per_round * req.rounds,
        "rounds": req.rounds,
        "round": 0,
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
            "rounds": req.rounds,
            "img2img": is_i2i,
            "strength": req.strength if is_i2i else None,
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
        "batch": task["request"]["batch"],
        "rounds": task["request"]["rounds"],
        **({"strength": task["request"]["strength"]}
           if task["request"]["img2img"] else {}),
        "loras": task["request"]["loras"],
        "created_at": int(time.time()),
        "model": "Krea 2 Turbo",
    }
    (OUTPUT_DIR / f"{stem}.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    keys = ("prompt", "style_name", "width", "height", "steps", "seed",
            "batch", "rounds", "loras", "created_at")
    if task["request"]["img2img"]:
        keys += ("strength",)
    return {"id": stem, "url": f"/outputs/{stem}.jpg", **{k: meta[k] for k in keys}}


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

        base_seed = req.seed if req.seed is not None else torch.randint(
            0, 2**31 - 1, (1,)).item()
        task["request"]["seed"] = base_seed

        # SDEdit 重绘：参考图编码一次，整轮任务共用（各轮/各张只换噪声）
        init_latents = None
        if req.init_image:
            init_latents = _encode_init_latents(
                req.init_image, task["request"]["width"],
                task["request"]["height"], req.batch)

        # 每轮独立调用管线（每轮 batch 张、独立种子 = 基种子 + 轮号），
        # 图片逐轮落盘并追加进 task，前端可边跑边看
        for round_idx in range(req.rounds):
            seed = base_seed + round_idx
            task["round"] = round_idx + 1

            generator = torch.Generator(device="cuda").manual_seed(seed)
            steps_this = req.steps
            extra = {}
            if init_latents is not None:
                # 截断 sigma 表并按幅度加噪；蒸馏权重 shift 固定 mu=1.15
                raw_sigmas, steps_this = _img2img_schedule(req.steps, req.strength)
                mu = 1.15 if _pipe.config.is_distilled else _dynamic_shift_mu(init_latents.shape[1])
                _pipe.scheduler.set_timesteps(sigmas=raw_sigmas, device="cuda", mu=mu)
                sigma0 = float(_pipe.scheduler.sigmas[0])
                noise = torch.randn(init_latents.shape, generator=generator,
                                    device=init_latents.device, dtype=init_latents.dtype)
                extra = {
                    "latents": sigma0 * noise + (1.0 - sigma0) * init_latents,
                    "sigmas": raw_sigmas,
                }

            def on_step(pipeline, step_index, timestep, kwargs):
                task["step"] = round_idx * steps_this + step_index + 1
                return kwargs

            result = _pipe(
                prompt=full_prompt,
                width=task["request"]["width"],
                height=task["request"]["height"],
                num_inference_steps=steps_this,
                guidance_scale=0.0,  # 蒸馏模型：CFG 关闭，负面提示词无效
                num_images_per_prompt=req.batch,
                generator=generator,
                callback_on_step_end=on_step,
                **extra,
            )
            for i, image in enumerate(result.images):
                task["images"].append(
                    _save_image(image, task, seed, round_idx * req.batch + i))
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
        task = TASKS.get(req.task_id)
        if task is None:
            continue
        # 模型加载中：原地等就绪（加载期间提交的任务自动排队，不拒绝）
        while MODEL_STATE["state"] == "loading":
            time.sleep(0.5)
        if MODEL_STATE["state"] != "ready" or _pipe is None:
            task["state"] = "error"
            task["error"] = f"模型未就绪：{MODEL_STATE.get('detail') or '未加载'}"
            task["finished_at"] = time.time()
            continue
        _run_task(req)


def start_background() -> None:
    """在 FastAPI lifespan 里调用：按默认精度加载模型 + 启动生成 worker。"""
    threading.Thread(target=load_model, args=(DEFAULT_PRECISION,),
                     name="model-loader", daemon=True).start()
    threading.Thread(target=_worker, name="gen-worker", daemon=True).start()


def enqueue(prompt: str, style_id: str, aspect_id: str, steps: int,
            seed: int | None, batch: int, rounds: int = 1,
            init_image: str | None = None, strength: float = 0.6,
            loras: list[tuple[str, float]] | None = None) -> str:
    req = GenRequest(
        task_id=uuid.uuid4().hex[:12],
        prompt=prompt,
        style_id=style_id,
        aspect_id=aspect_id,
        steps=steps,
        seed=seed,
        batch=batch,
        rounds=rounds,
        init_image=init_image,
        strength=strength,
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
