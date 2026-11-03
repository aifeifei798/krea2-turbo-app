#!/usr/bin/env python3
"""命令行出图：走本工作台的 HTTP API（与 UI 同一套队列与密钥）。

用法:
  scripts/gen.py "一只柴犬坐在铺满银杏叶的台阶上，秋日午后暖光" --style photo --aspect 2:3
  scripts/gen.py "霓虹小巷" --style cinema --rounds 4 --out-dir ./out
  scripts/gen.py "换条红围巾" --image 输入图.jpg --strength 0.75

密钥: 读 KREA_API_KEY 环境变量，其次项目 .env；查看当前值用 ./server.sh key。
依赖: 仅 Python 标准库；兼容 .venv/bin/python 与系统 python3。
"""

import argparse
import base64
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def resolve_key() -> str:
    k = os.environ.get("KREA_API_KEY", "").strip()
    if k:
        return k
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("KREA_API_KEY="):
                return line.split("=", 1)[1].strip()
    sys.exit("未找到 API 密钥：设置 KREA_API_KEY 环境变量，或用 ./server.sh key 查看")


def request(url: str, payload: dict | None = None, key: str = ""):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET",
                                 headers={"Content-Type": "application/json",
                                          "X-API-Key": key})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=30).read())
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read()).get("detail", "")
        except Exception:
            detail = ""
        sys.exit(f"HTTP {e.code}: {detail or e.reason}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Krea 2 Turbo 命令行出图")
    ap.add_argument("prompt", help="提示词")
    ap.add_argument("--style", action="append", default=[], metavar="ID", help="风格 id，可重复")
    ap.add_argument("--role", help="角色 id")
    ap.add_argument("--common", default="", help="通用词（放在提示词最前）")
    ap.add_argument("--aspect", default="1:1", help="比例，如 1:1 / 16:9（默认 1:1）")
    ap.add_argument("--steps", type=int, default=8)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--batch", type=int, default=1, help="每轮张数")
    ap.add_argument("--rounds", type=int, default=1, help="轮数")
    ap.add_argument("--image", help="参考图路径（图生图）")
    ap.add_argument("--strength", type=float, default=0.6, help="重绘幅度（配合 --image）")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8420)
    ap.add_argument("--out-dir", default="", help="把成图复制到该目录（缺省只打印 outputs 里的路径）")
    a = ap.parse_args()

    key = resolve_key()
    base = f"http://{a.host}:{a.port}"

    body = {
        "prompt": a.prompt, "styles": a.style, "role": a.role,
        "common": a.common, "aspect": a.aspect, "steps": a.steps,
        "seed": a.seed, "batch": a.batch, "rounds": a.rounds,
        "loras": [],  # 常驻 LoRA 由服务端激活策略决定；显式列表留空
    }
    if a.image:
        p = Path(a.image)
        if not p.exists():
            sys.exit(f"参考图不存在: {p}")
        body["init_image"] = base64.b64encode(p.read_bytes()).decode()
        body["strength"] = a.strength

    task = request(f"{base}/api/generate", body, key)
    tid = task.get("task_id")
    if not tid:
        sys.exit(f"提交失败: {task}")
    print(f"任务 {tid} 已提交")

    while True:
        st = request(f"{base}/api/tasks/{tid}", None, key)
        state = st.get("state")
        if state == "queued":
            print("\r排队中…      ", end="", flush=True)
        elif state == "running":
            print(f"\r扩散中 {st.get('step', 0)}/{st.get('total_steps', '?')}   ",
                  end="", flush=True)
        elif state == "error":
            sys.exit(f"\n生成失败: {st.get('error')}")
        elif state == "done":
            break
        time.sleep(1)

    print()
    out_dir = Path(a.out_dir) if a.out_dir else None
    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)
    for img in st.get("images", []):
        src = ROOT / "outputs" / f"{img['id']}.jpg"
        if out_dir:
            dst = out_dir / f"{img['id']}.jpg"
            shutil.copy(src, dst)
            print(dst)
        else:
            print(src.resolve())


if __name__ == "__main__":
    main()
