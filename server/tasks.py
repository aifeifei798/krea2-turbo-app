"""生成任务：图像编码（SDEdit/修图）、单线程 worker、任务队列与落盘。

- 生成请求进入单线程队列（GPU 一次只跑一个任务，避免显存争抢）
- 任务状态存 state.TASKS，前端轮询 /api/tasks/{id}
"""

import json
import logging
import threading
import time
import uuid
from pathlib import Path

import numpy as np
import torch

from . import paths, state
from .lora import list_loras, sync_loras
from .model import DEFAULT_PRECISION, load_model
from .presets import get_aspect, get_role, get_style, record_usage

logger = logging.getLogger("krea.pipeline")

BASE_DIR = Path(__file__).resolve().parent.parent
OUTPUT_DIR = BASE_DIR / "outputs"


# ---------------------------------------------------------------- 图像编码（SDEdit / 修图）

MAX_IMAGE_B64 = 32 * 2**20   # 参考图/蒙版 base64 上限（前端压缩后最长边 1536，实测远低于此）
MAX_IMAGE_PIXELS = 40_000_000  # 解码后像素上限，拦住解压炸弹（40MP ≈ 7680×5200）


class ImageLimitError(ValueError):
    """图片超出体积/分辨率上限（消息可直接回给前端，与「不是有效图片」区分开）"""


def _open_image_b64(b64: str):
    """base64/data URL → 惰性 PIL Image（只解析文件头），并做体积/像素上限检查。
    非法输入抛异常。调用方要像素数据时再 convert()/load()。"""
    import base64
    import io

    from PIL import Image
    if b64.startswith("data:"):
        b64 = b64.split(",", 1)[-1]
    if len(b64) > MAX_IMAGE_B64:
        raise ImageLimitError(f"图片数据过大：{len(b64) / 2**20:.1f} MB"
                              f"（上限 {MAX_IMAGE_B64 // 2**20} MB）")
    img = Image.open(io.BytesIO(base64.b64decode(b64, validate=True)))
    if img.width * img.height > MAX_IMAGE_PIXELS:
        raise ImageLimitError(f"图片分辨率过大：{img.width}×{img.height}")
    return img


def _decode_image_b64(b64: str):
    """接受裸 base64 或 data URL，返回 RGB PIL Image；非法输入抛异常。"""
    return _open_image_b64(b64).convert("RGB")


def _image_size_b64(b64: str) -> tuple[int, int]:
    """只读文件头拿尺寸：4K 图约 14ms，比完整解码（约 96ms）省 7 倍。
    校验请求体是否为合法图片时用它，别为了拿尺寸把像素解开。"""
    return _open_image_b64(b64).size


def _img_to_tensor(img) -> torch.Tensor:
    """PIL 图 → (1,3,1,H,W)、[-1,1] 的 bf16 张量。
    .copy() 不是白费的：np.asarray(PIL) 拿到的是只读视图，torch.from_numpy 会告警；
    这次拷贝实测约 0.03ms，换掉每次出图的告警刷屏很划算。"""
    arr = torch.from_numpy(np.asarray(img).copy()).permute(2, 0, 1)[None, :, None]
    return arr.to(torch.bfloat16) / 127.5 - 1.0


def _prepare_init_pil(img, width: int, height: int, crop: bool = True):
    """参考图预处理成与输出同尺寸的 PIL 图：crop=True 中心裁剪到目标比例再缩放
    （SDEdit 按所选比例），False 直接缩放（修图保持整图内容，mask 与输出逐像素对齐）。
    尺寸均为 16 的倍数对齐。VAE 输入端用 BICUBIC：4K→1024 实测 45ms（LANCZOS 69ms），
    图生图后面还要加噪再编码，这 24ms 的插值质量差异在像素上不可见。"""
    from PIL import Image
    if crop:
        scale = max(width / img.width, height / img.height)
        nw, nh = round(img.width * scale), round(img.height * scale)
        img = img.resize((nw, nh), Image.Resampling.BICUBIC)
        left, top = (nw - width) // 2, (nh - height) // 2
        return img.crop((left, top, left + width, top + height))
    return img.resize((width, height), Image.Resampling.BICUBIC)


def _prepare_init_tensor(img, width: int, height: int, crop: bool = True) -> torch.Tensor:
    """预处理后的参考图 → (1,3,1,H,W)、[-1,1] 的 bf16 张量。
    .copy() 不是白费的：np.asarray(PIL) 拿到的是只读视图，torch.from_numpy 会告警；
    这次拷贝实测约 0.03ms，换掉每次出图的告警刷屏很划算。"""
    return _img_to_tensor(_prepare_init_pil(img, width, height, crop))


INPAINT_MAX_EDGE = 1536  # 修图输出最长边上限（与前端参考图压缩一致）


def _inpaint_dims(size: tuple[int, int]) -> tuple[int, int]:
    """修图输出尺寸：按原图比例缩到最长边 ≤ INPAINT_MAX_EDGE，宽高取 16 的倍数
    （VAE 8x × patch 2 对齐）。只收尺寸，避免为了算尺寸把整张图解回来。"""
    w0, h0 = size
    scale = min(1.0, INPAINT_MAX_EDGE / max(w0, h0))
    w = max(256, round(w0 * scale / 16) * 16)
    h = max(256, round(h0 * scale / 16) * 16)
    return w, h


@torch.no_grad()
def _encode_init_latents(img, width: int, height: int, batch: int,
                         crop: bool = True) -> torch.Tensor:
    """参考图（已解码的 RGB PIL 图）→ 模型空间的初始潜变量（已 pack、未加噪）
    (batch, seq, ch*p*p)。编码约定与 QwenImage 官方管线一致：z.mode() 后 (z - mean) / std。
    crop=True 中心裁剪（SDEdit 按所选比例）；False 直接缩放（修图跟原图）。
    收 PIL 图而不是 base64：同一张 4K 图完整解码约 96ms，原先一个任务要解 3~4 遍
    （接口校验、探尺寸、编码前各来一次），白烧 300ms CPU，其中一遍还压在 TASKS 锁里。
    必须 no_grad：否则 Wan VAE 编码的激活图全被 autograd 扣住直接 OOM。
    调用方持有 model_lock。"""
    x = _prepare_init_tensor(img, width, height, crop).to(state.pipe._execution_device)
    vae = state.pipe.vae
    z = vae.encode(x).latent_dist.mode()  # (1, z_dim, 1, h, w)，取确定性 mode
    mean = torch.tensor(vae.config.latents_mean, device=z.device, dtype=z.dtype).view(1, -1, 1, 1, 1)
    std = torch.tensor(vae.config.latents_std, device=z.device, dtype=z.dtype).view(1, -1, 1, 1, 1)
    x0 = ((z - mean) / std)[:, :, 0]  # 去时间维 → (1, ch, h, w)
    lh, lw = height // state.pipe.vae_scale_factor, width // state.pipe.vae_scale_factor
    ch = state.pipe.transformer.config.in_channels // (state.pipe.patch_size ** 2)
    packed = state.pipe._pack_latents(x0, 1, ch, lh, lw)
    return packed.expand(batch, -1, -1)


def _prepare_inpaint_mask(mask_b64: str, width: int, height: int,
                          batch: int) -> tuple[torch.Tensor, "Image.Image"]:
    """修图蒙版（白=重绘）→（潜变量网格软 mask，像素级合成用 L 模蒙版）。
    潜变量 mask 已 pack 成与潜变量同形状，前端画笔自带软边、缩放采样再平滑一次。
    调用方持有 model_lock。"""
    import torch.nn.functional as F

    from PIL import Image
    mimg = _open_image_b64(mask_b64).convert("L")  # 直接转灰度，省一次 RGB 中间图
    comp_mask = mimg.resize((width, height), Image.BILINEAR)  # 像素合成用（白=重绘）
    t = torch.from_numpy(np.asarray(comp_mask).copy()).float()[None, None] / 255.0
    lh, lw = height // state.pipe.vae_scale_factor, width // state.pipe.vae_scale_factor
    ch = state.pipe.transformer.config.in_channels // (state.pipe.patch_size ** 2)
    m_lat = F.interpolate(t, size=(lh, lw), mode="bilinear", align_corners=False)
    m_lat = m_lat.repeat(1, ch, 1, 1).to(torch.bfloat16).to(state.pipe._execution_device)
    packed = state.pipe._pack_latents(m_lat, 1, ch, lh, lw)
    logger.info("inpaint mask: comp min=%.3f max=%.3f mean=%.3f | packed min=%.3f max=%.3f mean=%.3f shape=%s",
                float(t.min()), float(t.max()), float(t.mean()),
                float(packed.float().min()), float(packed.float().max()), float(packed.float().mean()),
                tuple(packed.shape))
    return packed.expand(batch, -1, -1), comp_mask


def _img2img_schedule(steps: int, strength: float) -> tuple[list[float], int]:
    """SDEdit 截断：从约等于幅度的噪声级起步（幅度越大起始噪声越多、改动越大），
    只跑剩下的步数；返回 (截断后 sigmas, 实际去噪步数)。
    幅度 0.95 ≈ 从纯噪声重画（近文生图），0.05 ≈ 1 步微调。"""
    actual = max(1, round(steps * strength))
    full = np.linspace(1.0, 1.0 / steps, steps).tolist()
    return full[steps - actual:], actual


def _dynamic_shift_mu(seq_len: int) -> float:
    """非蒸馏权重的分辨率感知 shift（与管线 calculate_shift 一致）；蒸馏权重固定 1.15。"""
    cfg = state.pipe.scheduler.config
    base_seq = cfg.get("base_image_seq_len", 256)
    max_seq = cfg.get("max_image_seq_len", 6400)
    base_shift = cfg.get("base_shift", 0.5)
    max_shift = cfg.get("max_shift", 1.15)
    return base_shift + (max_shift - base_shift) * (seq_len - base_seq) / (max_seq - base_seq)


# ---------------------------------------------------------------- 任务

def _new_task(req: state.GenRequest) -> dict:
    is_i2i = bool(req.init_image)
    is_inpaint = bool(req.mask_image)
    if is_inpaint:
        # 修图：尺寸跟原图（最长边限内 16 对齐），输出与蒙版逐像素对齐
        aw, ah = _inpaint_dims(_image_size_b64(req.init_image))
        aspect = {"id": "auto", "name": "跟原图", "width": aw, "height": ah}
    else:
        aspect = get_aspect(req.aspect_id)
    all_loras = {l["id"]: l for l in list_loras()}
    # 重绘按幅度截断 sigma 表（幅度越大起始噪声越多），每轮实际去噪步数变少（进度条按真实步数计）
    steps_per_round = _img2img_schedule(req.steps, req.strength)[1] if is_i2i else req.steps
    role = get_role(req.role)
    role = role if role and role["id"] == req.role else None  # 未知角色忽略
    return {
        "task_id": req.task_id,
        "state": "queued",
        "step": 0,
        "total_steps": steps_per_round * req.rounds,
        "rounds": req.rounds,
        "round": 0,
        "canceled": False,
        "error": None,
        "images": [],
        "request": {
            "prompt": req.prompt,
            "styles": [{"id": sid, "name": get_style(sid)["name"]}
                       for sid in req.styles if get_style(sid)["id"] == sid],
            "role": {"id": role["id"], "name": role["name"]} if role else None,
            "common": req.common.strip() or None,
            "aspect_id": aspect["id"],
            "width": aspect["width"],
            "height": aspect["height"],
            "steps": req.steps,
            "seed": req.seed,
            "batch": req.batch,
            "rounds": req.rounds,
            "img2img": is_i2i,
            "inpaint": is_inpaint,
            "source_id": req.source_id if is_inpaint else None,
            "strength": req.strength if is_i2i else None,
            "loras": [
                {"id": lid, "name": all_loras[lid]["name"], "weight": weight}
                for lid, weight in req.loras if lid in all_loras
            ],
        },
    }


def _bake_exif_params(image, jpg_path: Path, meta: dict) -> None:
    """把完整提示词与关键参数写进 JPG EXIF UserComment（A1111 兼容格式），
    分享出去的图在别的工具里也能读到全套参数。"""
    from PIL import Image

    full = meta.get("full_prompt") or meta.get("prompt") or ""
    styles = " · ".join(s["name"] for s in meta.get("styles", []))
    params = (f"{full}\n"
              f"Steps: {meta['steps']}, Seed: {meta['seed']}, "
              f"Size: {meta['width']}x{meta['height']}, Model: Krea 2 Turbo"
              + (f", Styles: {styles}" if styles else "")
              + (", Inpaint" if meta.get("inpaint") else ""))
    # UserComment 约定：8 字节字符码 "UNICODE\0" + UTF-16-BE 正文
    exif = Image.Exif()
    exif[0x9286] = b"UNICODE\x00" + params.encode("utf-16-be")
    try:
        image.save(jpg_path, quality=95, exif=exif.tobytes())
    except Exception as exc:  # noqa: BLE001 - EXIF 失败不该影响出图
        logger.warning("exif bake failed: %s", exc)
        image.save(jpg_path, quality=95)


def _alloc_stem(task: dict, seed: int, index: int) -> str:
    """生成唯一文件名主干。并发/连点+固定种子时，同一秒内 (seed, index) 可能撞车，
    撞了就直接覆盖上一张图，所以存在即加后缀。单个 worker 串行落盘，这里是竞态安全的。"""
    ts = time.strftime("%Y%m%d_%H%M%S")
    base = f"{ts}_{seed}_{index}" if task["request"]["batch"] > 1 else f"{ts}_{seed}"
    stem, n = base, 1
    while (OUTPUT_DIR / f"{stem}.jpg").exists() or (OUTPUT_DIR / f"{stem}.json").exists():
        n += 1
        stem = f"{base}_{n}"
    return stem


def _save_image(image, task: dict, seed: int, index: int, src_prepared=None) -> dict:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    stem = _alloc_stem(task, seed, index)
    jpg_path = OUTPUT_DIR / f"{stem}.jpg"

    meta = {
        "id": stem,
        "prompt": task["request"]["prompt"],
        "full_prompt": task["request"].get("full_prompt", ""),
        "styles": task["request"]["styles"],
        "role": task["request"]["role"],
        "aspect_id": task["request"]["aspect_id"],
        "width": task["request"]["width"],
        "height": task["request"]["height"],
        "steps": task["request"]["steps"],
        "seed": seed,
        "batch": task["request"]["batch"],
        "rounds": task["request"]["rounds"],
        "common": task["request"]["common"],
        **({"strength": task["request"]["strength"]}
           if task["request"]["img2img"] else {}),
        **({"inpaint": True} if task["request"]["inpaint"] else {}),
        **({"source_id": task["request"]["source_id"]}
           if task["request"].get("source_id") else {}),
        "loras": task["request"]["loras"],
        "created_at": int(time.time()),
        "model": "Krea 2 Turbo",
    }
    # 图生图/修图的「改图前」原图：与成品逐像素对齐，画廊灯箱前后对比用。
    # 落盘失败只丢对比能力，不影响成品本身
    has_src = False
    if src_prepared is not None:
        try:
            src_dir = OUTPUT_DIR / "src"
            src_dir.mkdir(parents=True, exist_ok=True)
            src_prepared.save(src_dir / f"{stem}.jpg", quality=95)
            has_src = True
        except Exception:  # noqa: BLE001
            logger.exception("source image save failed")
    if has_src:
        meta["src"] = True
    _bake_exif_params(image, jpg_path, meta)
    (OUTPUT_DIR / f"{stem}.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    keys = ("prompt", "full_prompt", "styles", "role", "common", "width",
            "height", "steps", "seed", "batch", "rounds", "loras", "created_at")
    if task["request"]["img2img"]:
        keys += ("strength",)
    if task["request"].get("source_id"):
        keys += ("source_id",)
    if has_src:
        keys += ("src",)
    return {"id": stem, "url": f"/outputs/{stem}.jpg", **{k: meta[k] for k in keys}}


def _run_task(req: state.GenRequest) -> None:
    task = state.TASKS.get(req.task_id)
    if task is None:
        return
    task["state"] = "running"
    try:
        from PIL import Image

        # 风格按选择顺序嵌套模板（{prompt} 替换为当前内容），角色描述前置
        full_prompt = req.prompt.strip()
        for sid in req.styles:
            tpl = get_style(sid)["template"]
            if not tpl:
                continue
            if "{prompt}" in tpl:
                full_prompt = tpl.replace("{prompt}", full_prompt)
            else:
                full_prompt = f"{full_prompt}, {tpl}"
        role = get_role(req.role)
        if role and role["prompt"]:
            full_prompt = f"{role['prompt'].rstrip(',; ')}, {full_prompt}"
        # 通用词放最前（画质词等）
        if req.common.strip():
            full_prompt = f"{req.common.strip().rstrip(',; ')}, {full_prompt}"
        # 实际发给模型的完整提示词进 meta（灯箱可查，跨工具复现不用猜）
        task["request"]["full_prompt"] = full_prompt

        # 缺的 LoRA 自动补加载（常驻，不卸载）；无请求时全部去激活
        sync_loras(req.loras)

        base_seed = req.seed if req.seed is not None else torch.randint(
            0, 2**31 - 1, (1,)).item()
        task["request"]["seed"] = base_seed

        # SDEdit 重绘：参考图编码一次，整轮任务共用（各轮/各张只换噪声）。
        # 修图（有蒙版）：尺寸跟原图直接缩放编码，另备蒙版与原图做逐步回注 + 最终像素合成
        init_latents = None
        mask_packed = None
        inv_mask_packed = None
        inpaint_src = None  # (原图缩放后 PIL, L 模蒙版) —— 像素级合成用
        src_prepared = None  # 与输出同尺寸的原图，落盘给画廊前后对比用
        if req.init_image:
            width, height = task["request"]["width"], task["request"]["height"]
            src_img = _decode_image_b64(req.init_image)  # 整个任务只解这一次
            init_latents = _encode_init_latents(
                src_img, width, height, req.batch, crop=not req.mask_image)
            if req.mask_image:
                mask_packed, comp_mask = _prepare_inpaint_mask(
                    req.mask_image, width, height, req.batch)
                # 反蒙版每步都要用，先算好一次；1.0 - mask 在 bf16 下逐步重算结果一致，
                # 只是白烧一次全潜变量的减法与分配
                inv_mask_packed = 1.0 - mask_packed
                # 合成源用 LANCZOS：蒙版外的像素就是成品像素，这里的锐度不能降级
                inpaint_src = (src_img.resize((width, height), Image.LANCZOS), comp_mask)
                src_prepared = inpaint_src[0]  # 对比原图与蒙版外的成品逐位一致
            else:
                src_prepared = _prepare_init_pil(src_img, width, height)

        # 每轮独立调用管线（每轮 batch 张、独立种子 = 基种子 + 轮号），
        # 图片逐轮落盘并追加进 task，前端可边跑边看；取消时当前轮丢弃、已完成轮保留
        for round_idx in range(req.rounds):
            if task.get("cancel"):
                task["canceled"] = True
                break
            seed = base_seed + round_idx
            task["round"] = round_idx + 1

            generator = torch.Generator(device="cuda").manual_seed(seed)
            steps_this = req.steps
            extra = {}
            if init_latents is not None:
                # 截断 sigma 表并按幅度加噪；蒸馏权重 shift 固定 mu=1.15
                raw_sigmas, steps_this = _img2img_schedule(req.steps, req.strength)
                mu = 1.15 if state.pipe.config.is_distilled else _dynamic_shift_mu(init_latents.shape[1])
                state.pipe.scheduler.set_timesteps(sigmas=raw_sigmas, device="cuda", mu=mu)
                sigma0 = float(state.pipe.scheduler.sigmas[0])
                noise = torch.randn(init_latents.shape, generator=generator,
                                    device=init_latents.device, dtype=init_latents.dtype)
                extra = {
                    "latents": sigma0 * noise + (1.0 - sigma0) * init_latents,
                    "sigmas": raw_sigmas,
                }

            def on_step(pipeline, step_index, timestep, kwargs):
                task["step"] = round_idx * steps_this + step_index + 1
                if mask_packed is not None:
                    # 修图：蒙版外（mask=0）每步回注「对应噪声级的原图潜变量」，
                    # 涂抹区（mask=1）保留模型输出真正去噪；与 QwenImageInpaintPipeline 同式
                    nxt = step_index + 1
                    s = raw_sigmas[nxt] if nxt < len(raw_sigmas) else 0.0
                    kept = s * noise + (1.0 - s) * init_latents
                    kwargs["latents"] = \
                        mask_packed * kwargs["latents"] + inv_mask_packed * kept
                return kwargs

            result = state.pipe(
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
            if task.get("cancel"):
                # 取消发生在本轮跑的过程中：半成品丢弃，不落盘
                task["canceled"] = True
                break
            for i, image in enumerate(result.images):
                if inpaint_src is not None:
                    # 像素级兜底合成：蒙版外逐像素保持原图（VAE 往返有微小色漂，这里归零）
                    image = Image.composite(image, inpaint_src[0], inpaint_src[1])
                task["images"].append(
                    _save_image(image, task, seed, round_idx * req.batch + i, src_prepared))
        task["state"] = "done"
        record_usage(req.styles, req.role)  # 成功才计使用频率
    except Exception as exc:  # noqa: BLE001 - 生成失败细节透出给前端
        logger.exception("generation failed")
        task["state"] = "error"
        task["error"] = str(exc)
    finally:
        task["finished_at"] = time.time()
        with state.lock:
            state.prune_tasks()


def _worker() -> None:
    while True:
        req = state.gen_queue.get()
        task = state.TASKS.get(req.task_id)
        if task is None:
            continue
        # 模型加载中：原地等就绪（加载期间提交的任务自动排队，不拒绝）
        while state.MODEL_STATE["state"] == "loading":
            time.sleep(0.5)
        if state.MODEL_STATE["state"] != "ready" or state.pipe is None:
            task["state"] = "error"
            task["error"] = f"模型未就绪：{state.MODEL_STATE.get('detail') or '未加载'}"
            task["finished_at"] = time.time()
            continue
        # 整轮生成持锁：期间卸载/换精度会等生成结束，避免 pipe 被换掉炸掉当前任务
        with state.model_lock:
            _run_task(req)


def start_background() -> None:
    """在 FastAPI lifespan 里调用：按默认精度加载模型 + 启动生成 worker。"""
    threading.Thread(target=load_model, args=(DEFAULT_PRECISION,),
                     name="model-loader", daemon=True).start()
    threading.Thread(target=_worker, name="gen-worker", daemon=True).start()


def enqueue(prompt: str, aspect_id: str, steps: int,
            seed: int | None, batch: int, rounds: int = 1,
            styles: list[str] | None = None, role: str | None = None,
            common: str = "",
            init_image: str | None = None, mask_image: str | None = None,
            strength: float = 0.6, source_id: str | None = None,
            loras: list[tuple[str, float]] | None = None) -> str:
    req = state.GenRequest(
        task_id=uuid.uuid4().hex[:12],
        prompt=prompt,
        styles=styles or [],
        role=role,
        common=common,
        aspect_id=aspect_id,
        steps=steps,
        seed=seed,
        batch=batch,
        rounds=rounds,
        init_image=init_image,
        mask_image=mask_image,
        strength=strength,
        source_id=source_id,
        loras=loras or [],
    )
    # 任务快照（含修图探尺寸的解码）在锁外组装：这一步是几十毫秒的 CPU 活儿，
    # 压进 state.lock 会拖住所有 /api/tasks 轮询，正是前端「卡一下」的来源
    task = _new_task(req)
    with state.lock:
        state.TASKS[req.task_id] = task
        state.prune_tasks()
    state.gen_queue.put(req)
    return req.task_id


def get_task(task_id: str) -> dict | None:
    with state.lock:
        task = state.TASKS.get(task_id)
        return json.loads(json.dumps(task)) if task else None  # 快照拷贝


def cancel_task(task_id: str) -> bool:
    """请求取消：排队任务轮前退出，运行中任务走管线 interrupt 提前收步。
    当前轮未落盘的半成品丢弃，已完成轮次保留。"""
    with state.lock:
        task = state.TASKS.get(task_id)
        if not task or task["state"] not in ("queued", "running"):
            return False
        task["cancel"] = True
        running = task["state"] == "running"
    if running and state.pipe is not None:
        state.pipe._interrupt = True  # diffusers 每步检查；下次 __call__ 开头自动复位
    return True
