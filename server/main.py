"""Krea 2 Turbo 文生图工作台 - FastAPI 入口。

启动：.venv/bin/python -m uvicorn server.main:app --host 127.0.0.1 --port 8420
"""

import json
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import pipeline
from .presets import ASPECTS, DEFAULT_STEPS, MAX_BATCH, MAX_STEPS, STYLES

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
OUTPUT_DIR = BASE_DIR / "outputs"


@asynccontextmanager
async def lifespan(app: FastAPI):
    pipeline.start_background()
    yield


app = FastAPI(title="Krea 2 Turbo 工作台", lifespan=lifespan)


class LoraIn(BaseModel):
    id: str
    weight: float = Field(default=1.0, ge=0.0, le=2.0)


class GenerateIn(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    style: str = "none"
    aspect: str = "1:1"
    steps: int = Field(default=DEFAULT_STEPS, ge=2, le=MAX_STEPS)
    seed: int | None = Field(default=None, ge=0, le=2**31 - 1)
    batch: int = Field(default=1, ge=1, le=MAX_BATCH)
    loras: list[LoraIn] = Field(default_factory=list, max_length=4)


@app.get("/api/status")
def status():
    return pipeline.get_load_state()


@app.get("/api/presets")
def presets():
    return {"styles": STYLES, "aspects": ASPECTS,
            "default_steps": DEFAULT_STEPS, "max_steps": MAX_STEPS}


@app.get("/api/loras")
def loras():
    return pipeline.list_loras()


@app.post("/api/generate")
def generate(body: GenerateIn):
    state = pipeline.get_load_state()
    if state["state"] == "loading":
        raise HTTPException(503, "模型加载中，请稍候")
    if state["state"] == "error":
        raise HTTPException(503, state["detail"])
    # 校验 LoRA id 有效性，未知 id 直接拒绝
    known = {l["id"] for l in pipeline.list_loras()}
    for lora in body.loras:
        if lora.id not in known:
            raise HTTPException(400, f"未知 LoRA: {lora.id}")
    task_id = pipeline.enqueue(
        prompt=body.prompt, style_id=body.style, aspect_id=body.aspect,
        steps=body.steps, seed=body.seed, batch=body.batch,
        loras=[(l.id, l.weight) for l in body.loras])
    return {"task_id": task_id}


@app.get("/api/tasks/{task_id}")
def task_status(task_id: str):
    task = pipeline.get_task(task_id)
    if task is None:
        raise HTTPException(404, "任务不存在或已过期")
    return task


def _load_meta(stem: str) -> dict | None:
    meta_path = OUTPUT_DIR / f"{stem}.json"
    if not meta_path.exists():
        return None
    try:
        return json.loads(meta_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


@app.get("/api/images")
def list_images():
    if not OUTPUT_DIR.exists():
        return []
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
    return metas


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
