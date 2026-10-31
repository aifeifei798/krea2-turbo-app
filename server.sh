#!/usr/bin/env bash
# Krea 2 Turbo 工作台启动脚本
#
# 用法: ./server.sh [精度] [端口]
#   精度: bf16（默认，画质无损）| int8（全 GPU ~16.7 GiB，最快）| int4（全 GPU ~9.9 GiB，最省）
#   端口: 默认 8420
#
# 例: ./server.sh int4          # int4 双量化启动
#     ./server.sh int8 9000    # int8 + 9000 端口
set -euo pipefail
cd "$(dirname "$0")"

PRECISION="${1:-bf16}"
PORT="${2:-8420}"

case "$PRECISION" in
  bf16|int8|int4) ;;
  *) echo "未知精度: $PRECISION（可选 bf16 | int8 | int4）" >&2; exit 1 ;;
esac

if [ ! -x .venv/bin/python ]; then
  echo "未找到 .venv，请先按 README 创建 Python 环境" >&2
  exit 1
fi

export KREA_PRECISION="$PRECISION"
echo "▸ Krea 2 Turbo 工作台 · 精度 ${PRECISION} · 端口 ${PORT} · 首次加载模型需几分钟"
exec .venv/bin/python -m uvicorn server.main:app --host 127.0.0.1 --port "$PORT"
