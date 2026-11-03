"""Krea 2 Turbo 文生图工作台 - FastAPI 入口。

启动：.venv/bin/python -m uvicorn server.main:app --host 127.0.0.1 --port 8420
"""

import hmac
import json
import logging
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import paths, pipeline

# pipeline 的 INFO（模型加载/LoRA 装载/状态迁移）落到 .server.log，便于排查卡顿
logging.basicConfig(level=logging.INFO)
from .presets import (DEFAULT_STEPS, MAX_BATCH, MAX_ROUNDS, MAX_STYLES,
                      MAX_STEPS, get_presets, get_role, get_style)

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
OUTPUT_DIR = BASE_DIR / "outputs"

# API 访问密钥：必须配置（.env 的 KREA_API_KEY），缺失直接拒绝启动
try:
    API_KEY = paths.get_api_key()
except paths.ApiKeyNotConfigured as exc:
    raise SystemExit(f"启动失败：{exc}") from None


@asynccontextmanager
async def lifespan(app: FastAPI):
    pipeline.start_background()
    yield


app = FastAPI(title="Krea 2 Turbo 工作台", lifespan=lifespan)


@app.middleware("http")
async def api_key_guard(request, call_next):
    """/api/* 一律校验 X-API-Key（UI 首次访问会弹窗收集并存储）；其余路径（页面/图片）开放。"""
    if request.url.path.startswith("/api"):
        given = request.headers.get("X-API-Key", "")
        if not hmac.compare_digest(given, API_KEY):
            return JSONResponse({"detail": "API 密钥缺失或不正确"}, status_code=401)
    return await call_next(request)


@app.middleware("http")
async def revalidate_static(request, call_next):
    """前端资源一律 no-cache 协商缓存：改完刷新即生效，杜绝旧 CSS/JS 撞新 HTML。"""
    resp = await call_next(request)
    p = request.url.path
    if not (p.startswith("/api") or p.startswith("/outputs")):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


class LoraIn(BaseModel):
    id: str
    weight: float = Field(default=pipeline.DEFAULT_LORA_WEIGHT, ge=0.0, le=2.0)


class GenerateIn(BaseModel):
    prompt: str = Field(default="", max_length=4000)  # 可为空：通用词/角色/风格也能撑起提示词
    styles: list[str] = Field(default_factory=list, max_length=MAX_STYLES)
    role: str | None = None
    common: str = Field(default="", max_length=600)  # 通用词（提示词最前）
    aspect: str = "1:1"
    steps: int = Field(default=DEFAULT_STEPS, ge=2, le=MAX_STEPS)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)  # torch.Generator 上限
    batch: int = Field(default=1, ge=1, le=MAX_BATCH)
    rounds: int = Field(default=1, ge=1, le=MAX_ROUNDS)
    init_image: str | None = Field(default=None, max_length=8_000_000)  # base64 参考图（重绘）
    mask_image: str | None = Field(default=None, max_length=8_000_000)  # base64 蒙版（白=重绘）
    strength: float = Field(default=0.6, ge=0.05, le=0.95)  # 重绘幅度
    loras: list[LoraIn] = Field(default_factory=list, max_length=8)


class ModelLoadIn(BaseModel):
    precision: Literal["bf16", "int8", "int4"]


class LoraToggleIn(BaseModel):
    id: str
    on: bool


@app.get("/api/status")
def status():
    return pipeline.get_model_state()


@app.get("/api/model")
def model_state():
    try:
        model_dir = str(paths.get_model_dir())
    except paths.ModelDirNotConfigured:
        model_dir = None
    return {**pipeline.get_model_state(),
            "model_dir": model_dir,
            "precision_hints": pipeline.get_precision_hints()}


@app.post("/api/model/load")
def model_load(body: ModelLoadIn):
    state = pipeline.get_model_state()
    if state["state"] == "loading":
        raise HTTPException(409, "模型正在加载中")
    threading.Thread(target=pipeline.load_model, args=(body.precision,),
                     name="model-loader", daemon=True).start()
    return {"ok": True, "precision": body.precision}


@app.post("/api/model/unload")
def model_unload():
    pipeline.unload_model()
    return {"ok": True}


@app.get("/api/presets")
def presets():
    return get_presets()


@app.get("/api/loras")
def loras():
    return pipeline.list_loras()


@app.post("/api/loras/toggle")
def lora_toggle(body: LoraToggleIn):
    try:
        return pipeline.toggle_lora(body.id, body.on)
    except RuntimeError as exc:
        raise HTTPException(409, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.post("/api/generate")
def generate(body: GenerateIn):
    # 修图（有蒙版）时提示词可空：只靠通用词/风格引导，或让涂抹区自然重生成
    if not body.prompt.strip() and not body.common.strip() and body.mask_image is None:
        raise HTTPException(400, "提示词与通用词不能同时为空")
    state = pipeline.get_model_state()
    # loading 状态不拒绝：任务入队，worker 等模型就绪后自动开跑
    if state["state"] == "unloaded":
        raise HTTPException(503, "模型未加载，请到「模型」页加载")
    if state["state"] == "error":
        raise HTTPException(503, state["detail"])
    # 校验 LoRA id 有效性，未知 id 直接拒绝
    known = {l["id"] for l in pipeline.list_loras()}
    for lora in body.loras:
        if lora.id not in known:
            raise HTTPException(400, f"未知 LoRA: {lora.id}")
    # 风格/角色 id 校验（风格去重保序）
    seen: set[str] = set()
    styles = []
    for sid in body.styles:
        if sid not in seen:
            seen.add(sid)
            styles.append(sid)
    for sid in styles:
        if get_style(sid)["id"] != sid:
            raise HTTPException(400, f"未知风格: {sid}")
    if body.role and get_role(body.role) is None:
        raise HTTPException(400, f"未知角色: {body.role}")
    # 参考图必须是可解码的有效图片
    if body.init_image is not None:
        try:
            pipeline._decode_image_b64(body.init_image)
        except Exception:  # noqa: BLE001 - 解码失败统一回 400
            raise HTTPException(400, "参考图不是有效的图片数据") from None
    # 蒙版：必须伴随参考图，且自身可解码
    if body.mask_image is not None:
        if body.init_image is None:
            raise HTTPException(400, "局部重绘需要同时提供原图与蒙版")
        try:
            pipeline._decode_image_b64(body.mask_image)
        except Exception:  # noqa: BLE001 - 解码失败统一回 400
            raise HTTPException(400, "蒙版不是有效的图片数据") from None
    task_id = pipeline.enqueue(
        prompt=body.prompt, aspect_id=body.aspect,
        steps=body.steps, seed=body.seed, batch=body.batch, rounds=body.rounds,
        styles=styles, role=body.role, common=body.common.strip(),
        init_image=body.init_image, mask_image=body.mask_image,
        strength=body.strength,
        loras=[(l.id, l.weight) for l in body.loras])
    return {"task_id": task_id}


@app.get("/api/tasks/{task_id}")
def task_status(task_id: str):
    task = pipeline.get_task(task_id)
    if task is None:
        raise HTTPException(404, "任务不存在或已过期")
    return task


@app.post("/api/tasks/{task_id}/cancel")
def task_cancel(task_id: str):
    if not pipeline.cancel_task(task_id):
        raise HTTPException(404, "任务不存在或已结束")
    return {"ok": True}


def _load_meta(stem: str) -> dict | None:
    meta_path = OUTPUT_DIR / f"{stem}.json"
    if not meta_path.exists():
        return None
    try:
        return json.loads(meta_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


GALLERY_PAGE_DEFAULT = 60  # 画廊单页数量


@app.get("/api/images")
def list_images(limit: int = GALLERY_PAGE_DEFAULT, before: str | None = None):
    """画廊分页：按 (created_at, id) 倒序；before 为上一页末条 "created_at:id" 游标。
    游标失效（图被删等）时从头重给，前端按 id 去重兜底。"""
    if not OUTPUT_DIR.exists():
        return {"items": [], "total": 0, "has_more": False}
    metas = []
    for jpg in OUTPUT_DIR.glob("*.jpg"):
        meta = _load_meta(jpg.stem)
        if meta is None:
            # 孤立图片（meta 丢失）也展示，元数据留空
            meta = {"id": jpg.stem, "prompt": "", "style_name": "",
                    "width": 0, "height": 0, "steps": 0, "seed": None,
                    "created_at": int(jpg.stat().st_mtime)}
        meta["url"] = f"/outputs/{jpg.name}"
        metas.append(meta)
    metas.sort(key=lambda m: (m["created_at"], m["id"]), reverse=True)
    total = len(metas)

    start = 0
    if before:
        try:
            ts, sid = before.rsplit(":", 1)
            key = (int(ts), sid)
            start = next((i for i, m in enumerate(metas)
                          if (m["created_at"], m["id"]) == key), -1) + 1
        except ValueError:
            start = 0
        if start <= 0:
            start = 0  # 游标失效：从头重给
    limit = max(1, min(limit, 200))
    page = metas[start:start + limit]
    return {"items": page, "total": total,
            "has_more": start + len(page) < total}


@app.delete("/api/images/{image_id}")
def delete_image(image_id: str):
    # image_id 只允许文件名安全字符，防路径穿越
    if not image_id or any(c in image_id for c in "/\\."):
        raise HTTPException(400, "非法图片 ID")
    removed = False
    for suffix in (".jpg", ".json"):
        p = OUTPUT_DIR / f"{image_id}{suffix}"
        if p.exists():
            p.unlink()
            removed = True
    if not removed:
        raise HTTPException(404, "图片不存在")
    return {"ok": True}


app.mount("/outputs", StaticFiles(directory=OUTPUT_DIR, check_dir=False), name="outputs")
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
