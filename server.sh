#!/usr/bin/env bash
# Krea 2 Turbo 工作台 启动/管理脚本
#
# 用法:
#   ./server.sh start  [精度] [端口]   后台启动（精度 bf16|int8|int4，默认 int8，端口默认 8420）
#   ./server.sh stop                   停止服务
#   ./server.sh restart [精度] [端口]  重启（不带精度则沿用上次）
#   ./server.sh status                 进程 + 模型 + 显存状态
#   ./server.sh log [行数|-f]          查看日志（默认 50 行，-f 跟随）
#   ./server.sh run    [精度] [端口]   前台启动（默认 int8，Ctrl+C 停止）
#   ./server.sh help                   本说明
#
# 兼容旧用法：./server.sh [bf16|int8|int4] 等价于 run。
set -euo pipefail
cd "$(dirname "$0")"

PORT_DEFAULT=8420
PID_FILE=".server.pid"
META_FILE=".server.meta"   # 记录 precision / port 供 restart、status 使用
LOG_FILE=".server.log"

PRECISIONS="bf16|int8|int4"

c_url()    { curl -s --max-time 2 "http://127.0.0.1:${PORT_DEFAULT}$1" 2>/dev/null || true; }
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

# 等待 API 报告模型 ready/error，最多 max_s 秒；输出最终状态行
wait_ready() {
  local max_s="${1:-180}" waited=0 state=""
  while [ "$waited" -lt "$max_s" ]; do
    state=$(curl -s --max-time 2 http://127.0.0.1:${PORT_DEFAULT}/api/model 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['state'])" 2>/dev/null || echo "")
    case "$state" in
      ready|error)
        curl -s --max-time 2 http://127.0.0.1:${PORT_DEFAULT}/api/model | python3 -c \
          "import json,sys;d=json.load(sys.stdin);print(f\"▸ 模型状态: {d['state']} · {d['detail']}\")"
        return 0 ;;
    esac
    sleep 3; waited=$((waited+3))
    printf "▸ 模型加载中 %ds…\r" "$waited"
  done
  echo "▸ 等待超时（${max_s}s），可稍后用 status 查看"; return 0
}

valid_precision() { case "$1" in bf16|int8|int4) return 0 ;; *) return 1 ;; esac; }

# ---------------------------------------------------------------- 动作

do_start() {
  local precision="${1:-}" port="${2:-}" pid portp
  [ -z "$precision" ] && precision=$(meta_get precision); [ -z "$precision" ] && precision=int8
  [ -z "$port" ] && port=$(meta_get port); [ -z "$port" ] && port=$PORT_DEFAULT
  valid_precision "$precision" || { echo "未知精度: $precision（可选 $PRECISIONS）" >&2; exit 1; }
  case "$port" in ''|*[!0-9]*) echo "非法端口: $port" >&2; exit 1 ;; esac

  pid=$(pid_file_pid)
  if pid_alive "$pid"; then
    echo "服务已在运行（PID $pid），如需重启用: ./server.sh restart"; exit 1
  fi
  rm -f "$PID_FILE"
  portp=$(port_pid "$port")
  if [ -n "$portp" ]; then
    echo "端口 $port 已被 PID $portp 占用（可能是未登记的实例），先处理它再用 start" >&2; exit 1
  fi

  if [ ! -x .venv/bin/python ]; then echo "未找到 .venv，请先按 README 创建 Python 环境" >&2; exit 1; fi

  # 日志超 32MB 归档为 .old（只留一代），防止 tqdm/访问日志无限膨胀
  if [ -f "$LOG_FILE" ] && [ "$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)" -gt $((32*1024*1024)) ]; then
    mv "$LOG_FILE" "$LOG_FILE.old"
  fi

  export KREA_PRECISION="$precision"
  nohup .venv/bin/python -m uvicorn server.main:app --host 127.0.0.1 --port "$port" >> "$LOG_FILE" 2>&1 &
  pid=$!
  echo "$pid" > "$PID_FILE"
  meta_set precision "$precision"; meta_set port "$port"
  echo "▸ 已启动: PID $pid · 精度 $precision · 端口 $port · 日志 $LOG_FILE"
  sleep 2
  pid_alive "$pid" || { echo "✗ 进程启动后立刻退出，查看: ./server.sh log 30" >&2; tail -5 "$LOG_FILE" >&2 || true; exit 1; }
  echo "▸ 服务端口已就绪，模型后台加载中（首次需几分钟）"
  wait_ready 180
}

do_stop() {
  local pid portp
  pid=$(pid_file_pid)
  if pid_alive "$pid"; then
    echo "▸ 停止 PID $pid …"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do pid_alive "$pid" || break; sleep 0.5; done
    pid_alive "$pid" && { echo "▸ 强制结束"; kill -9 "$pid" 2>/dev/null || true; }
    echo "▸ 已停止"
  elif [ -n "$pid" ]; then
    echo "▸ PID $pid 已不在运行"
  else
    echo "▸ 没有 PID 记录"
  fi
  portp=$(port_pid "${2:-$PORT_DEFAULT}")
  [ -n "$portp" ] && echo "⚠ 端口 ${2:-$PORT_DEFAULT} 仍被 PID $portp 占用（非本脚本启动？）" >&2
  rm -f "$PID_FILE"
}

do_status() {
  local pid port precision state json
  port=$(meta_get port); [ -z "$port" ] && port=$PORT_DEFAULT
  precision=$(meta_get precision); [ -z "$precision" ] && precision="?"
  pid=$(pid_file_pid)
  echo "═══ Krea 2 Turbo 工作台 ═══"
  if pid_alive "$pid"; then
    echo "进程:   运行中 · PID $pid · 端口 $port · 上次精度 $precision"
  else
    portp=$(port_pid "$port")
    if [ -n "$portp" ]; then
      echo "进程:   PID $portp 占用端口 $port（非本脚本登记）"
    else
      echo "进程:   未运行（启动: ./server.sh start [精度]）"
      echo "═══"; return 0
    fi
  fi
  json=$(curl -s --max-time 2 "http://127.0.0.1:$port/api/model")
  if [ -n "$json" ]; then
    echo "$json" | python3 -c "import json,sys;d=json.load(sys.stdin);print(f\"模型:   {d['state']} · {d['detail']}\")"
    lora=$(curl -s --max-time 2 "http://127.0.0.1:$port/api/loras" | python3 -c "import json,sys;ls=json.load(sys.stdin);print(sum(1 for l in ls if l['loaded']), '/', len(ls))" 2>/dev/null || echo "?")
    echo "LoRA:   已加载 $lora"
  else
    echo "模型:   API 无响应（可能模型加载中或服务异常，看: ./server.sh log 30）"
  fi
  command -v nvidia-smi >/dev/null 2>&1 && \
    nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader | head -1 | \
    awk -F', ' '{printf "显存:   %s / %s\n", $1, $2}'
}

do_log() {
  local arg="${1:-50}"
  if [ "$arg" = "-f" ]; then tail -f "$LOG_FILE"; else tail -n "${arg:-50}" "$LOG_FILE"; fi
}

do_run() {
  local precision="${1:-int8}" port="${2:-$PORT_DEFAULT}" pid
  valid_precision "$precision" || { echo "未知精度: $precision（可选 $PRECISIONS）" >&2; exit 1; }
  [ ! -x .venv/bin/python ] && { echo "未找到 .venv，请先按 README 创建 Python 环境" >&2; exit 1; }
  export KREA_PRECISION="$precision"
  meta_set precision "$precision"; meta_set port "$port"
  echo "▸ 前台运行 · 精度 $precision · 端口 $port（Ctrl+C 停止）"
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
  *)       echo "未知命令: $CMD（可选 start | stop | restart | status | log | run | help）" >&2
           do_help >&2; exit 1 ;;
esac
