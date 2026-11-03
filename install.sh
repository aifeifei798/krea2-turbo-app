#!/usr/bin/env bash
# Krea 2 Turbo 工作台 一键安装：虚拟环境 + 依赖 + .env 配置
# 用法: ./install.sh
set -euo pipefail
cd "$(dirname "$0")"

say()  { echo "▸ $*"; }
warn() { echo "⚠ $*" >&2; }
die()  { echo "✗ $*" >&2; exit 1; }

say "Krea 2 Turbo 工作台 安装"

# ---------------------------------------------------------------- 基础检查

command -v python3 >/dev/null 2>&1 || die "未找到 python3（需 3.10+，建议 3.12）"
nvidia-smi >/dev/null 2>&1 || warn "未检测到 NVIDIA GPU/驱动——推理需要 CUDA GPU"

# 磁盘提示：模型 ~34G、预量化再 ~26G、venv ~10G
avail_gb=$(($(df -Pk . | awk 'NR==2 {print $4}') / 1024 / 1024))
[ "$avail_gb" -lt 60 ] && warn "当前目录磁盘剩余约 ${avail_gb}G——模型+环境建议预留 60G+"

# ---------------------------------------------------------------- 虚拟环境

if [ -x .venv/bin/python ]; then
  say "复用已有 .venv"
elif command -v uv >/dev/null 2>&1; then
  say "用 uv 创建虚拟环境…"
  uv venv --python 3.12 .venv 2>/dev/null || uv venv .venv || die "uv venv 失败"
else
  say "用 python3 -m venv 创建虚拟环境…"
  python3 -m venv .venv || die "venv 创建失败（Debian/Ubuntu 需先安装 python3-venv）"
fi

# ---------------------------------------------------------------- 依赖

if [ ! -x .venv/bin/pip ] && ! .venv/bin/python -m pip --version >/dev/null 2>&1; then
  die "venv 里没有 pip（uv 创建的 venv 需要用 uv 装依赖）"
fi

say "安装依赖（torch 较大，可能需要几分钟）…"
if command -v uv >/dev/null 2>&1; then
  uv pip install --python .venv/bin/python -r requirements.txt || die "依赖安装失败"
else
  .venv/bin/python -m pip install --upgrade pip >/dev/null
  .venv/bin/python -m pip install -r requirements.txt || die "依赖安装失败"
fi

# CUDA 可用性自检
.venv/bin/python - <<'PY' || warn "torch.cuda 不可用——推理会失败，请检查 NVIDIA 驱动与 torch 版本"
import torch
ok = torch.cuda.is_available()
name = torch.cuda.get_device_name(0) if ok else "-"
print(f"▸ CUDA: {ok} · {name} · torch {torch.__version__}")
raise SystemExit(0 if ok else 1)
PY

# ---------------------------------------------------------------- .env 配置

if [ -f .env ]; then
  say "复用已有 .env"
else
  cp .env.example .env
  say "已从 .env.example 生成 .env"
  mdir=""
  if [ -t 0 ]; then
    read -r -p "模型目录 KREA_MODEL_DIR（diffusers 检查点路径，回车跳过稍后手改）: " mdir || mdir=""
  fi
  if [ -n "$mdir" ]; then
    if [ -f "$mdir/model_index.json" ]; then
      safe=${mdir//&/\\&}
      sed -i "s|^KREA_MODEL_DIR=.*|KREA_MODEL_DIR=$safe|" .env
      say "KREA_MODEL_DIR 已写入 .env"
    else
      warn "$mdir 下没有 model_index.json——请编辑 .env 填入正确路径"
    fi
  else
    warn "未填写模型目录——启动前请编辑 .env 设置 KREA_MODEL_DIR"
  fi
fi

chmod +x server.sh

# ---------------------------------------------------------------- 完成

say "安装完成。下一步："
echo "  1. 确认 .env 里 KREA_MODEL_DIR 指向你的模型（兼容 Krea 2 架构的 diffusers 检查点）"
echo "  2. 可选加速：.venv/bin/python scripts/export_quantized.py all  # 预量化，冷启动约 3 倍"
echo "  3. ./server.sh start   # 后台启动，浏览器打开 http://127.0.0.1:8420"
