# AGENTS.md — Krea 2 Turbo 工作台

本地单用户文生图工作台：FastAPI（server/）+ 原生 JS ES modules（static/js/）+ Tailwind v4。运行在 RTX 5090 本机，面向浏览器 127.0.0.1:8420。详细功能说明看 `README.md`。

## 目录

- `server/` — main.py（FastAPI 路由）、pipeline.py（**门面**，重导出下方四模块；main.py 只 import 它）、state.py（共享状态：管线实例/模型状态/任务表/锁，依赖图叶子）、model.py（模型加载/卸载/精度）、lora.py（LoRA 常驻）、tasks.py（图像编码/生成 worker/任务队列）、paths.py（.env 目录配置）、presets.py（比例/风格/角色聚合+用量统计）、style_data.py 与 juese_data.py（**生成文件，勿手改**，由 scripts/port_presets.py 从外部数据转换）
- `static/js/` — 前端 16 个 ES 模块（无打包器，`<script type="module">` 直载）
- `static/css/` — src/app.css 为源，dist/app.css 为构建产物（gitignored）
- `scripts/` — port_presets.py（预设数据转换）、export_quantized.py（预量化导出）、gen.py（命令行出图）、mcp_server.py（MCP server，给 AI agent 用）、check_i18n.mjs / check_imports.mjs（静态校验，见下）
- `install.sh` / `server.sh` — 安装与服务管理；`outputs/` 落盘图片+json 元数据

## 常用命令

```bash
./server.sh start|stop|restart|status|log [-f]   # 服务管理（输出已着色，重定向自动去色）
node_modules/.bin/tailwindcss -i static/css/src/app.css -o static/css/dist/app.css --minify
.venv/bin/python -m py_compile server/*.py        # Python 语法检查
node --check static/js/<file>.js                  # JS 检查（ES module 需复制为 .mjs 再查）
node scripts/check_i18n.mjs                       # i18n 键完整性（t()/data-i18n vs 语言包，缺键退出码 1）
node scripts/check_imports.mjs                    # 前端模块导入健康（import 名必须在目标导出里）
node ~/.zcode/skills/design-forge/scripts/forge.mjs static/index.html static/js/*.js static/css/src/app.css
```

改 JS 文案（t()/data-i18n）后跑 check_i18n；改任何 import 后跑 check_imports——这两个都是历史踩坑的固化，交付前必跑。

改前端静态文件刷新即生效（`/api`、`/outputs` 之外的路由都走 no-cache 中间件）；改后端必须 `./server.sh restart`（预量化 int8 冷启动约 35s）。

## 配置（.env）

`KREA_MODEL_DIR` 与 `KREA_API_KEY` 必填（无代码默认值；模型目录缺失时 server.sh 预检拒绝启动，API key 缺失时 server.sh start/run 自动生成写回 `.env`，main.py 导入时二次硬校验）。可选 `KREA_LORA_DIR`、`KREA_MODEL_INT8_DIR`、`KREA_MODEL_INT4_DIR`、`KREA_LORA_AUTLOAD=0`。见 `.env.example`。server.sh 启动时自动 source `.env`。`.env` 本体 gitignored。

**API 访问控制**：所有 `/api/*` 请求要求 `X-API-Key` 头（`hmac.compare_digest` 常量时间比较，401 拒绝）；静态页面/图片/语言包开放。前端统一走 core.js 的 `apiFetch()`——自动附头，401 弹窗收集（密钥存 localStorage `krea2-api-key`）后自动重试一次；新增接口也必须走它。脚本/curl 调试带 `-H "X-API-Key: $(./server.sh key)"`；server.sh 内部 curl 已自带；查当前密钥 `./server.sh key`。

## 架构边界（改代码前必读）

- **前端依赖单向无环**：i18n.js（叶子）→ core.js（state/$/toast/escape/friendlyApiError/apiFetch/syncDataBlock/bindTheme）← settings.js ← {lora, picker, common-words} ← {model-page, studio, queue} ← {gallery, inpaint} ← {lightbox（经 gallery.registerLightbox 回调拿到开关能力）, inpaint-fine（经 inpaint.js 的访问器读写共享笔迹）}；crop.js 只依赖 core/i18n，由 studio.js 调 `bindCrop(applyCroppedInit)` 装配；app.js 只做装配。新增共享工具放 core.js，跨模块状态一律访问器函数（数组会被整体重置，引用不能长期持有），不要制造反向引用。
- **后端依赖单向无环**：state.py（叶子：pipe/MODEL_STATE/TASKS/两把锁/GenRequest）← lora.py 与 model.py（model 只在 load 时调 lora._load_all_loras_locked，lora 不依赖 model）← tasks.py；pipeline.py 是纯门面（重导出），main.py 只 import pipeline。新接口加到对应模块并经 pipeline.py 重导出。
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
- 预量化目录解析链：`.env` 显式（KREA_MODEL_INT8_DIR/INT4_DIR/FP8_DIR）→ 同级 `-int8/-int4/-fp8` 约定 → 现场量化；显式无效自动回退。`paths._is_prequant` 只校验 `transformer/config.json`，文本编码器由 model.py 按组件再校验（fp8 只导 transformer，编码器复用 int8 目录）。
- **fp8 = torchao W8A8 + `torch.compile(dynamic=True)`**：实测 1216×832 每步 766ms(int8) → 448ms(fp8)，API 端到端 7.2s → 3.9s。编译只对 fp8 开——int8 走 torchao 自定义算子，实测编译 30 分钟不收敛。`dynamic=True` 一次覆盖所有分辨率；`static` 每换一个尺寸要重编 40~60s（inductor 磁盘缓存命中后约 8s）。
- 编译必须装在 LoRA 注入之后（PEFT 会替换子模块，先编译拿到失效引用）；LoRA「启用 ↔ 禁用」每切换一次要重编一张图，所以 fp8 的 `load_model` 会在 ready 之后起后台线程，先把「常驻但禁用」那张图编掉（模型页显示「预编译内核中」），此时进来的任务在 model_lock 上排队等。batch 1/2/4 也各是一张图（首次用到各付一次编译）。编译缓存落在 `~/.cache/torchinductor`：进程内首次约 50s，缓存命中后约 3~8s。
- VAE 必须开 `enable_slicing()`：fp8+编译后显存更紧，batch=4 @1216×832 的解码要再挤 2.18 GiB 直接 OOM；切片按 batch 逐张解码、输出逐位等价（不是 tiling 那种近似），batch=1 无影响。
- 根目录 AGENTS.md 与 README.md 是权威文档；改服务管理/安装流程时同步 server.sh 头部注释与 README。
- 批量替换（python/sed）必须先断言出现次数、替换后复核——静默 no-op 会埋雷（bindTheme 就是这么从 import 里丢的，页面假死「连接中」）。
- server.sh 头部注释是 awk 提取的帮助文本；编辑头部时替换若把行首 `#` 顶掉，该行会变成裸代码执行（曾引发调自身的 fork 炸弹）。
- IAB 浏览器 evaluate 不能动态 import 模块（importModule 未定义）——模块级验证走文件比对/服务器端 grep，页面级走 DOM 断言与事件注入。
- 合成事件的 pointerId 调 `setPointerCapture` 会抛 NotFoundError——画布 handler 里必须 try/catch（主画布与精细弹窗都已处理）。
- 前后端重复常量以 `/api/presets` 为准（max_styles/max_steps/default_steps），不要在前端再写死；`DEFAULT_LORA_WEIGHT`(0.4) 目前前后端各一份（lora.js / lora.py，pipeline 门面转发），改要同步。
- 修图/图生图链路两个反直觉点，改之前先读 README「实现备注」：取消走 `pipe._interrupt`（`if self.interrupt: continue`，**不抛异常**，且 `__call__` 开头会复位，故 `on_step` 每步补旗）；蒙版外重注入的噪声级必须取 `scheduler.sigmas`（time_shift 之后），不能用 `_img2img_schedule` 的 raw 表。
- 模型加载/卸载的两个约束：加载入口统一走 `model.request_load()`（原子占位，连点只受理一次，别再在端点里「先查 state 再起线程」）；worker 的「就绪」判断必须在 `model_lock` 内，因为 `_unload_locked` 先置 `pipe=None` 再改状态，锁外读会撞上「state=ready 但 pipe 已是 None」，把重载期间提交的任务误判成未就绪。

## 浏览器验证配方（IAB 实测有效）

- **载图**：IAB 不支持 file chooser——`DataTransfer` 构造 File 塞进 `i2i-file`/`inpaint-file` 再 `dispatchEvent(new Event("change", {bubbles:true}))`。
- **涂抹**：画布上 `dispatchEvent(new PointerEvent(type, {pointerId:任意, pointerType:"mouse", clientX, clientY, isPrimary:true}))`，pointerdown→move×N→up。
- **笔迹验证**：canvas `getImageData` 统计预览色像素（`r>200 && g<140 && a>60`）。
- **修图保真**：PIL 对比 outputs 前后图，断言蒙版外变化像素 ≈0（阈值 >2 容 JPEG 落盘噪声）。
- **捕获提交体**：包一层 `window.fetch` 记录 /api/generate 的 body（页面 reload 后钩子失效，需重挂）。
- **测试前置**：i18n/主题/密钥存 localStorage（`krea2-lang`/`krea2-theme`/`krea2-api-key`），按需清理。
