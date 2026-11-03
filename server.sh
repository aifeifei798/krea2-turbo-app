#!/usr/bin/env bash
# Krea 2 Turbo 工作台 · 服务管理
#
# 用法:
#   ./server.sh start   [精度] [端口]   后台启动（默认精度 int8，默认端口 8420）
#   ./server.sh stop                    停止服务
#   ./server.sh key                     显示 API 访问密钥
#   ./server.sh restart [精度] [端口]   重启（缺省沿用上次精度）
#   ./server.sh status                  服务 / 模型 / LoRA / 显存状态
#   ./server.sh log     [行数|-f]       查看日志（默认 50 行，-f 跟随输出）
#   ./server.sh run     [精度] [端口]   前台运行（Ctrl+C 停止）
#   ./server.sh help                    显示本说明
#
# 目录等启动配置见 .env（参考 .env.example）；兼容写法：./server.sh int8 等价于 run
set -euo pipefail
cd "$(dirname "$0")"

PORT_DEFAULT=8420
PID_FILE=".server.pid"
META_FILE=".server.meta"   # 记录 precision / port 供 restart、status 使用
LOG_FILE=".server.log"

PRECISIONS="bf16|int8|int4"

# ---------------------------------------------------------------- 输出工具

if [ -t 1 ]; then
  C_G=$'\033[32m' C_R=$'\033[31m' C_Y=$'\033[33m' C_C=$'\033[36m' C_DIM=$'\033[2m' C_B=$'\033[1m' C_0=$'\033[0m'
else
  C_G="" C_R="" C_Y="" C_C="" C_DIM="" C_B="" C_0=""
fi
ok()   { echo "${C_G}✓${C_0} $*"; }
err()  { echo "${C_R}✗${C_0} $*" >&2; }
warn() { echo "${C_Y}⚠${C_0} $*" >&2; }
hint() { echo "${C_DIM}  $*${C_0}"; }

c_url()    { curl -s --max-time 2 -H "X-API-Key: ${KREA_API_KEY:-}" "http://127.0.0.1:${PORT_DEFAULT}$1" 2>/dev/null || true; }
meta_get() { [ -f "$META_FILE" ] && grep -m1 "^$1=" "$META_FILE" | cut -d= -f2 || true; }
meta_set() { touch "$META_FILE"; grep -v "^$1=" "$META_FILE" > "$META_FILE.tmp" 2>/dev/null || true; mv "$META_FILE.tmp" "$META_FILE"; echo "$1=$2" >> "$META_FILE"; }

pid_alive()    { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
pid_file_pid() { [ -f "$PID_FILE" ] && cat "$PID_FILE" || true; }

# 端口被占用的进程 PID（兜底：PID 文件丢失时用）
port_pid() {
  local port="$1" pid=""
  if command -v fuser >/dev/null 2>&1; then
    pid=$(fuser "$port/tcp" 2>/dev/null | tr -s ' ' | xargs || true)
  elif command -v ss >/dev/null 2>&1; then
    pid=$(ss -tlnp 2>/dev/null | grep ":$port " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)
  fi
  echo "$pid"
}

valid_precision() { case "$1" in bf16|int8|int4) return 0 ;; *) return 1 ;; esac; }

# 预检：API 密钥必须存在（.env 的 KREA_API_KEY）——缺失时自动生成并写回 .env
ensure_api_key() {
  if [ -z "${KREA_API_KEY:-}" ]; then
    local key
    key=$(.venv/bin/python -c "import secrets; print(secrets.token_hex(16))")
    {
      [ -f .env ] && echo "" || echo "# Krea 2 Turbo 启动配置"
      echo "# API 访问密钥（自动生成于 $(date '+%F %T')；UI 首次打开时输入一次即可）"
      echo "KREA_API_KEY=$key"
    } >> .env
    export KREA_API_KEY="$key"
    echo "${C_Y}▸ 已自动生成 KREA_API_KEY 并写入 .env：${C_0}${C_B}$key${C_0}"
  fi
}

# 预检：模型目录必须已配置且为有效检查点（.env 提供，见 .env.example）
check_model_dir() {
  if [ -z "${KREA_MODEL_DIR:-}" ]; then
    err "未配置模型目录 —— 复制 .env.example 为 .env 并设置 KREA_MODEL_DIR（见 README）"
    exit 1
  fi
  if [ ! -f "$KREA_MODEL_DIR/model_index.json" ]; then
    err "KREA_MODEL_DIR 不是有效的 diffusers 模型目录（缺 model_index.json）: $KREA_MODEL_DIR"
    exit 1
  fi
}

# 等待 API 报告模型 ready/error，最多 max_s 秒；输出最终状态行
wait_ready() {
  local max_s="${1:-180}" waited=0 state="" detail=""
  while [ "$waited" -lt "$max_s" ]; do
    json=$(curl -s --max-time 2 -H "X-API-Key: ${KREA_API_KEY:-}" http://127.0.0.1:${PORT_DEFAULT}/api/model 2>/dev/null || true)
    if [ -n "$json" ]; then
      read -r state detail < <(echo "$json" | python3 -c \
        "import json,sys;d=json.load(sys.stdin);print(d['state'], d['detail'])" 2>/dev/null || true)
      case "$state" in
        ready)
          echo "${C_G}✓${C_0} 模型就绪  ${C_B}${detail}${C_0}"
          return 0 ;;
        error)
          echo "${C_R}✗${C_0} 模型加载失败  ${detail}"
          return 0 ;;
      esac
    fi
    sleep 3; waited=$((waited+3))
    printf "  模型加载中 %ds…\r" "$waited"
  done
  warn "等待超时（${max_s}s）—— 稍后用 ./server.sh status 查看状态"
  return 0
}

# ---------------------------------------------------------------- 动作

do_start() {
  local precision="${1:-}" port="${2:-}" pid portp
  [ -z "$precision" ] && precision=$(meta_get precision); [ -z "$precision" ] && precision=int8
  [ -z "$port" ] && port=$(meta_get port); [ -z "$port" ] && port=$PORT_DEFAULT
  valid_precision "$precision" || { err "无效精度 \"$precision\"（可选：bf16 | int8 | int4）"; exit 1; }
  case "$port" in ''|*[!0-9]*) err "无效端口 \"$port\""; exit 1 ;; esac

  pid=$(pid_file_pid)
  if pid_alive "$pid"; then
    err "服务已在运行（PID $pid）—— 重启请用 ./server.sh restart"
    exit 1
  fi
  rm -f "$PID_FILE"
  portp=$(port_pid "$port")
  if [ -n "$portp" ]; then
    err "端口 $port 已被 PID $portp 占用 —— 释放端口后再启动"
    exit 1
  fi

  if [ ! -x .venv/bin/python ]; then
    err "未找到 .venv —— 先运行 ./install.sh 完成安装"
    exit 1
  fi

  # .env（可选）：模型/LoRA 目录等启动配置，见 .env.example
  set -a; [ -f .env ] && . ./.env; set +a
  ensure_api_key
  check_model_dir

  # 日志超 32MB 归档为 .old（只留一代），防止 tqdm/访问日志无限膨胀
  if [ -f "$LOG_FILE" ] && [ "$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)" -gt $((32*1024*1024)) ]; then
    mv "$LOG_FILE" "$LOG_FILE.old"
  fi

  export KREA_PRECISION="$precision"
  nohup .venv/bin/python -m uvicorn server.main:app --host 127.0.0.1 --port "$port" >> "$LOG_FILE" 2>&1 &
  pid=$!
  echo "$pid" > "$PID_FILE"
  meta_set precision "$precision"; meta_set port "$port"
  ok "服务已启动  ${C_DIM}PID $pid · 端口 $port · 精度 $precision · 日志 $LOG_FILE${C_0}"
  sleep 2
  pid_alive "$pid" || { err "进程启动后立即退出 —— 查看原因：./server.sh log 30"; tail -5 "$LOG_FILE" >&2 || true; exit 1; }
  ok "端口就绪，模型加载中（首次约 1–2 分钟）"
  wait_ready 180
  echo "${C_DIM}→ 日志 ./server.sh log -f${C_0}"
}

do_stop() {
  local pid portp
  pid=$(pid_file_pid)
  if pid_alive "$pid"; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do pid_alive "$pid" || break; sleep 0.5; done
    if pid_alive "$pid"; then
      warn "进程未响应，已强制结束"
      kill -9 "$pid" 2>/dev/null || true
    fi
    ok "已停止  ${C_DIM}PID $pid${C_0}"
  elif [ -n "$pid" ]; then
    hint "PID $pid 已退出，清理记录"
  else
    hint "没有运行中的实例"
  fi
  portp=$(port_pid "${2:-$PORT_DEFAULT}")
  [ -n "$portp" ] && warn "端口 ${2:-$PORT_DEFAULT} 仍被 PID $portp 占用（非本脚本启动的进程）"
  rm -f "$PID_FILE"
}

do_status() {
  local pid port precision json portp
  set -a; [ -f .env ] && . ./.env; set +a
  port=$(meta_get port); [ -z "$port" ] && port=$PORT_DEFAULT
  precision=$(meta_get precision); [ -z "$precision" ] && precision="—"
  pid=$(pid_file_pid)
  echo "${C_B}Krea 2 Turbo 工作台${C_0}"
  echo "${C_DIM}────────────────────────────────────────────${C_0}"

  if pid_alive "$pid"; then
    echo "  服务    ${C_G}● 运行中${C_0}   PID $pid · 端口 $port · 精度 $precision"
  else
    portp=$(port_pid "$port")
    if [ -n "$portp" ]; then
      echo "  服务    ${C_Y}● 端口占用${C_0} PID $portp（非本脚本登记）"
    else
      echo "  服务    ○ 未运行  ${C_DIM}—— ./server.sh start 启动${C_0}"
      echo "${C_DIM}────────────────────────────────────────────${C_0}"
      return 0
    fi
  fi

  json=$(c_url "/api/model")
  if [ -n "$json" ]; then
    read -r m_state m_detail < <(echo "$json" | python3 -c \
      "import json,sys;d=json.load(sys.stdin);print(d['state'], d['detail'])" 2>/dev/null || true)
    case "$m_state" in
      ready)   echo "  模型    ${C_G}● 就绪${C_0}     $m_detail" ;;
      loading) echo "  模型    ${C_Y}◐ 加载中${C_0}   $m_detail" ;;
      error)   echo "  模型    ${C_R}● 失败${C_0}     $m_detail" ;;
      *)       echo "  模型    ○ 未加载" ;;
    esac
    lora=$(c_url "/api/loras" | python3 -c "import json,sys;ls=json.load(sys.stdin);print(f\"{sum(1 for l in ls if l['loaded'])} / {len(ls)} 已加载\")" 2>/dev/null || echo "—")
    echo "  LoRA    $lora"
  else
    echo "  模型    — API 无响应（可能加载中或服务异常，./server.sh log 30）"
  fi
  if command -v nvidia-smi >/dev/null 2>&1; then
    vram=$(nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader | head -1 | awk -F', ' '{print $1 " / " $2}')
    echo "  显存    $vram"
  fi
  echo "${C_DIM}────────────────────────────────────────────${C_0}"
  echo "${C_DIM}  日志 ./server.sh log -f · 帮助 ./server.sh help${C_0}"
}

do_log() {
  local arg="${1:-50}"
  if [ "$arg" = "-f" ]; then tail -f "$LOG_FILE"; else tail -n "${arg:-50}" "$LOG_FILE"; fi
}

do_run() {
  local precision="${1:-int8}" port="${2:-$PORT_DEFAULT}" pid
  valid_precision "$precision" || { err "无效精度 \"$precision\"（可选：bf16 | int8 | int4）"; exit 1; }
  if [ ! -x .venv/bin/python ]; then
    err "未找到 .venv —— 先运行 ./install.sh 完成安装"
    exit 1
  fi
  set -a; [ -f .env ] && . ./.env; set +a
  ensure_api_key
  check_model_dir
  export KREA_PRECISION="$precision"
  meta_set precision "$precision"; meta_set port "$port"
  ok "前台运行  ${C_DIM}精度 $precision · 端口 $port（Ctrl+C 停止）${C_0}"
  .venv/bin/python -m uvicorn server.main:app --host 127.0.0.1 --port "$port" &
  pid=$!
  echo "$pid" > "$PID_FILE"
  trap 'kill "$pid" 2>/dev/null || true; rm -f "$PID_FILE"' EXIT
  wait "$pid"
}

do_help() {
  awk 'NR > 1 { if ($0 ~ /^#/) { sub(/^# ?/, ""); print } else exit }' "$0"
}

# ---------------------------------------------------------------- 入口

CMD="${1:-}"
case "$CMD" in
  key)     set -a; [ -f .env ] && . ./.env; set +a
           if [ -n "${KREA_API_KEY:-}" ]; then echo "$KREA_API_KEY"; else
             err "未配置 KREA_API_KEY —— 启动时会自动生成，或手动加进 .env"; exit 1; fi ;;
  start)   shift; do_start "$@" ;;
  stop)    shift; do_stop "$@" ;;
  restart)
    shift
    pid=$(pid_file_pid)
    if pid_alive "$pid"; then do_stop; sleep 1; fi
    do_start "$@" ;;
  status)  shift; do_status "$@" ;;
  log)     shift; do_log "$@" ;;
  run)     shift; do_run "$@" ;;
  help|-h|--help) do_help ;;
  bf16|int8|int4) do_run "$@" ;;
  "")      do_help ;;
  *)       err "未知命令 \"$CMD\" —— 可用：start | stop | restart | status | log | run | key | help"
           do_help >&2; exit 1 ;;
esac
