#!/usr/bin/env python3
"""Krea 2 Turbo MCP server：把本机出图能力暴露给 AI agent（stdio 传输）。

注册到 MCP 客户端（ZCode / Claude Desktop 等）：
  {
    "mcpServers": {
      "krea2-turbo": {
        "command": "<项目路径>/.venv/bin/python",
        "args": ["<项目路径>/scripts/mcp_server.py"]
      }
    }
  }

密钥：与 HTTP API 同一个 KREA_API_KEY（自动读环境变量或项目 .env）；
本服务只在本地 stdio 运行，密钥不出机。服务端须已启动（./server.sh start）。
依赖：mcp>=2（requirements.txt 已含）。
"""

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from mcp.server.mcpserver import MCPServer

ROOT = Path(__file__).resolve().parent.parent
mcp = MCPServer("krea2-turbo", instructions=(
    "Krea 2 Turbo 本地文生图工作台：8 步蒸馏出图，支持文生图/图生图/局部重绘、"
    "风格与角色预设、LoRA。先 list_styles 拿风格 id，再 generate 出图（默认等待完成并返回图片路径）。"
))

HOST = "127.0.0.1"
PORT = int(os.environ.get("KREA_PORT", "8420"))


def resolve_key() -> str:
    k = os.environ.get("KREA_API_KEY", "").strip()
    if k:
        return k
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("KREA_API_KEY="):
                return line.split("=", 1)[1].strip()
    raise RuntimeError("未找到 KREA_API_KEY：设置环境变量或确认项目 .env（./server.sh key 查看）")


def api(path: str, payload: dict | None = None, timeout: int = 30) -> dict:
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        f"http://{HOST}:{PORT}{path}", data=data,
        method="POST" if data else "GET",
        headers={"Content-Type": "application/json", "X-API-Key": resolve_key()})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=timeout).read())
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read()).get("detail", "")
        except Exception:
            detail = ""
        raise RuntimeError(f"HTTP {e.code}: {detail or e.reason}") from None


MCP_B64_SOFT_MAX = 24 * 2**20  # 超过这个体积先缩图再传（服务端硬上限 32 MB）


def _read_image_b64(path: str) -> str:
    """本地图 → base64。超大原图（几十 MB 的手机原图/PNG 导出）先缩到最长边 1536
    再转 JPEG，与网页端参考图压缩一致，免得撞服务端体积上限。"""
    p = Path(path)
    if not p.exists():
        raise RuntimeError(f"图片不存在: {p}")
    raw = p.read_bytes()
    b64 = base64.b64encode(raw).decode()
    if len(b64) <= MCP_B64_SOFT_MAX:
        return b64

    import io

    from PIL import Image
    with Image.open(p) as img:
        img = img.convert("RGB")
        img.thumbnail((1536, 1536), Image.Resampling.BICUBIC)
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=92)
    return base64.b64encode(buf.getvalue()).decode()


def _resolve_style_token(token: str, styles: list[dict]) -> str | None:
    """风格参数既可用 id 也可用中文名。"""
    token = token.strip()
    for s in styles:
        if s["id"] == token:
            return s["id"]
    for s in styles:
        if s["name"] == token:
            return s["id"]
    return None


@mcp.tool()
def get_status() -> str:
    """服务与模型状态：是否就绪、当前精度、显存占用、LoRA 加载数、画廊总数。"""
    st = api("/api/status")
    loras = api("/api/loras")
    loaded = sum(1 for l in loras if l["loaded"])
    gallery = api("/api/images?limit=1")
    detail = st.get("detail", "")
    return (f"模型状态: {st['state']}（{detail}）\n"
            f"精度: {st.get('precision') or '—'} · 显存 {st.get('vram_gb') or '—'} GiB\n"
            f"LoRA: {loaded}/{len(loras)} 已加载 · 画廊共 {gallery.get('total', 0)} 张")


@mcp.tool()
def list_styles() -> str:
    """列出全部风格预设（id 与中文名，按使用频率排序）。generate 的 styles 参数用这里的 id 或名称。"""
    styles = api("/api/presets")["styles"]
    return "\n".join(f"{s['id']} — {s['name']}（已用 {s.get('usage', 0)} 次）" for s in styles)


@mcp.tool()
def list_images(limit: int = 10) -> str:
    """最近生成的图片：路径、提示词摘要、尺寸、种子。limit 上限 50。"""
    limit = max(1, min(limit, 50))
    items = api(f"/api/images?limit={limit}")["items"]
    if not items:
        return "画廊还是空的"
    out = []
    for it in items:
        path = ROOT / "outputs" / f"{it['id']}.jpg"
        snippet = (it.get("prompt") or "（无提示词）")[:40]
        size = f"{it.get('width', '?')}×{it.get('height', '?')}" if it.get("width") else "—"
        out.append(f"{path}\n    {snippet} · {size} · seed {it.get('seed', '—')}")
    return "\n".join(out)


@mcp.tool()
def generate(
    prompt: str,
    styles: list[str] | None = None,
    role: str = "",
    common: str = "",
    aspect: str = "1:1",
    steps: int = 8,
    seed: int | None = None,
    batch: int = 1,
    rounds: int = 1,
    init_image: str = "",
    mask_image: str = "",
    strength: float = 0.6,
    timeout_s: int = 600,
) -> str:
    """生成图片并等待完成，返回图片的本地路径。

    styles: 风格 id 或中文名列表（先 list_styles 查询，最多 4 个）；
    common: 通用词（画质词，拼在提示词最前）；
    aspect: "1:1" / "3:2" / "2:3" / "16:9" / "9:16" / "2:1" / "1:2"；
    init_image: 参考图本地路径 → 图生图；mask_image: 蒙版路径（白=重绘）→ 局部重绘，
    两者都给时尺寸跟原图。rounds>1 可一次出多轮（每轮换种子）。"""
    presets = api("/api/presets")
    style_ids, skipped = [], []
    for token in (styles or []):
        sid = _resolve_style_token(token, presets["styles"])
        (style_ids.append(sid) if sid else skipped.append(token))
    role_id = role.strip() or None

    body = {
        "prompt": prompt,
        "styles": style_ids[:4],
        "role": role_id,
        "common": common,
        "aspect": aspect,
        "steps": max(2, min(steps, 16)),
        "seed": seed,
        "batch": max(1, min(batch, 4)),
        "rounds": max(1, min(rounds, 8)),
        "loras": [],  # LoRA 常驻由服务端管理，agent 不直改
    }
    if init_image:
        body["init_image"] = _read_image_b64(init_image)
        body["strength"] = strength
        if mask_image:
            body["mask_image"] = _read_image_b64(mask_image)

    task = api("/api/generate", body)
    tid = task["task_id"]
    deadline = time.time() + max(60, min(timeout_s, 1800))
    while True:
        st = api(f"/api/tasks/{tid}")
        if st["state"] == "done":
            break
        if st["state"] == "error":
            raise RuntimeError(f"生成失败: {st.get('error')}")
        if time.time() > deadline:
            raise RuntimeError(f"等待超时（任务 {tid} 仍在 {st['state']}，可用 list_images 稍后查看）")
        time.sleep(1.5)

    lines = [f"已生成 {len(st['images'])} 张:"]
    for img in st["images"]:
        lines.append(str(ROOT / "outputs" / f"{img['id']}.jpg"))
    req = st["request"]
    lines.append(f"seed: {req.get('seed')} · 完整提示词: {req.get('full_prompt', '')[:120]}")
    if skipped:
        lines.append(f"未识别的风格已忽略: {', '.join(skipped)}")
    return "\n".join(lines)


if __name__ == "__main__":
    mcp.run(transport="stdio")
