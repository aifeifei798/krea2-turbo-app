# AGENTS.md — Krea 2 Turbo 工作台

本地单用户文生图工作台：FastAPI（server/）+ 原生 JS ES modules（static/js/）+ Tailwind v4。运行在 RTX 5090 本机，面向浏览器 127.0.0.1:8420。详细功能说明看 `README.md`。

## 目录

- `server/` — main.py（FastAPI 路由）、pipeline.py（模型加载/单 worker 生成队列/LoRA 常驻）、paths.py（.env 目录配置）、presets.py（比例/风格/角色聚合+用量统计）、style_data.py 与 juese_data.py（**生成文件，勿手改**，由 scripts/port_presets.py 从外部数据转换）
- `static/js/` — 前端按职责拆分的 9 个 ES 模块（无打包器，`<script type="module">` 直载）
- `static/css/` — src/app.css 为源，dist/app.css 为构建产物（gitignored）
- `scripts/` — port_presets.py（预设数据转换）、export_quantized.py（预量化导出）
- `install.sh` / `server.sh` — 安装与服务管理；`outputs/` 落盘图片+json 元数据

## 常用命令

```bash
./server.sh start|stop|restart|status|log [-f]   # 服务管理（输出已着色，重定向自动去色）
node_modules/.bin/tailwindcss -i static/css/src/app.css -o static/css/dist/app.css --minify
.venv/bin/python -m py_compile server/*.py        # Python 语法检查
node --check static/js/<file>.js                  # JS 检查（ES module 需复制为 .mjs 再查）
node ~/.zcode/skills/design-forge/scripts/forge.mjs static/index.html static/js/*.js static/css/src/app.css
```

改前端静态文件刷新即生效（`/api`、`/outputs` 之外的路由都走 no-cache 中间件）；改后端必须 `./server.sh restart`（预量化 int8 冷启动约 35s）。

## 配置（.env）

`KREA_MODEL_DIR` 必填（无代码默认值，缺失时 server.sh 预检拒绝启动并给指引）；可选 `KREA_LORA_DIR`、`KREA_MODEL_INT8_DIR`、`KREA_MODEL_INT4_DIR`、`KREA_LORA_AUTLOAD=0`。见 `.env.example`。server.sh 启动时自动 source `.env`。`.env` 本体 gitignored。

## 架构边界（改代码前必读）

- **前端依赖单向无环**：core.js（state/$/toast/escape/friendlyApiError/syncDataBlock）← settings.js ← {lora, picker, common-words} ← {model-page, studio, queue} ← gallery；app.js 只做装配。新增共享工具放 core.js，不要制造反向引用。
- **模块顶层 const 不挂 window**：浏览器 evaluate/控制台看不到 `state`，调试用 DOM 断言。
- **后端队列**：单 worker 串行；整个生成持 `_model_lock`（卸载/精度切换会等生成结束）；LoRA 开关 acquire(timeout=2s) 忙时 409。
- **Prompt 拼装顺序**（pipeline._run_task）：通用词 → 角色描述前置 → 风格模板按选择顺序嵌套 `{prompt}` → 用户提示词。
- **蒸馏模型 CFG=0**：负面提示词无效（style 数据里的 negative_prompt 仅保留不生效）。
- **模型页加载中提交不拒绝**：任务入队等就绪；worker 的等待循环在锁外。

## 已知坑

- `pkill -f <模式>` 会匹配到自己的命令行导致 shell 自杀——按端口杀（`fuser -k 8420/tcp`）。
- `server/style_data.py`、`juese_data.py` 是单行巨型 repr，grep 会刷屏——加文件名限定或过滤 `^server/`。
- static/css/dist 是构建产物，手改会被覆盖；改样式只动 src 再跑构建命令。
- `.usage.json`（风格用量）、`krea2-panel-v1`/`krea2-combos-v1`（localStorage）是运行时数据；`.env`、`.usage.json`、`.server.*`、`outputs/` 均 gitignored。
- 预量化目录解析链：`.env` 显式（KREA_MODEL_INT8_DIR/INT4_DIR）→ 同级 `-int8/-int4` 约定 → 现场量化；显式无效自动回退。
- 根目录 AGENTS.md 与 README.md 是权威文档；改服务管理/安装流程时同步 server.sh 头部注释与 README。
