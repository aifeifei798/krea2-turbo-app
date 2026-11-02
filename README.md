# Krea 2 Turbo 本地文生图工作台

基于 [Krea 2 Turbo](https://huggingface.co/krea/Krea-2-Turbo)（12B DiT 蒸馏文生图模型）的本地出图工作台：FastAPI 后端 + 原生 JS 前端 + Tailwind CSS v4。

![前端](static/favicon.svg)

## 特性

- **8 步蒸馏出图**：`guidance_scale=0.0`，RTX 5090 上 1024² 约几秒一张
- **图生图重绘（SDEdit）**：「模式 → 图生图」上传参考图 + 重绘幅度 0.05–0.95——参考图按比例中心裁剪后 VAE 编码，按幅度截断 sigma 表加噪去噪（与 QwenImage 官方管线同一套 `latents_mean/std` 编码约定）；构图保留、提示词改风格/细节，批量/次数/LoRA/种子全部通用
- **LoRA 混合**：模型加载完成后 `loras/` 目录的 LoRA **默认全部加载并常驻显存**（不随生成自动卸载），默认强度 0.4；「模型」页开关可单独卸载/重载，强度 0–2 独立调节、拖动即时生效
  - 自动兼容两种格式：diffusers PEFT 格式直载；ComfyUI/kohya 格式（`diffusion_model.` 前缀）自动把 `alpha` 标量按 `alpha/rank` 预乘进 `lora_B` 后加载
- **模型精度可选**（「模型」页，RTX 5090 32GB 实测，量化作用于 transformer 与文本编码器）：
  | 精度 | 显存（常驻/峰值） | 512²/8 步 | 说明 |
  |---|---|---|---|
  | bf16 | offload 模式（峰值 ~24 GiB） | ~9s | 画质无损 |
  | int8（torchao int8wo） | ~16.7 / 18.2 GiB | ~3.4s | 全 GPU，速度最快 |
  | int4（bnb nf4） | ~9.9 / 11.4 GiB | ~2.4s | 最省显存，画质略降 |
  精度切换需重载模型（约半分钟）。|
- **风格预设**：写实摄影 / 电影感 / 动漫 / 水墨 / 像素 / 低多边形 / 黑白 / 印象派 / 扁平海报
- **比例预设**：1:1、3:2、2:3、16:9、9:16（均为 16 像素倍数对齐）
- **步数 4–16、批量 1–4（每轮张数）、次数 1–8（跑几轮）、seed 固定复现**
  - 次数模式每轮独立跑一遍管线（每轮 `batch` 张、种子 = 基种子 + 轮号），图片逐轮落盘并实时进画廊；中途失败保留已完成轮次的图
- **面板参数本地记忆**：提示词、风格、比例、步数、批量、次数、种子、精度、LoRA 强度自动存入浏览器 localStorage，刷新/重开自动恢复上次的调整（存档失效自动回默认）
- **作品库**：落盘 `outputs/`（jpg + 同名 json 元数据，含 LoRA 参数），画廊 / 灯箱 / 下载 / 删除
- **模型 CPU offload**：12B DiT + Qwen3-VL 文本编码器按需进出 32GB 显存
- **双视图界面**：顶栏「制作 / 模型」切换 —— 制作页专注出图（LoRA 只留摘要条），模型页管理基础模型状态与 LoRA 开关/强度

> 注意：蒸馏模型 CFG 已关闭，**负面提示词无效**，所以界面没有这个输入。

## 启动与管理

```bash
chmod +x server.sh

./server.sh start          # 后台启动（默认 int8，也可指定 bf16|int8|int4；端口默认 8420）
./server.sh status         # 进程 / 模型 / LoRA / 显存状态
./server.sh log -f         # 跟随日志（或 log 30 看最近 30 行）
./server.sh restart        # 重启（沿用上次精度；也可带精度参数）
./server.sh stop           # 停止

./server.sh run bf16       # 前台运行（默认 int8，Ctrl+C 停止），./server.sh int4 是它的等价写法
```

或手动分步：

```bash
# 1) Python 环境（torch 需 cu128 及以上以支持 5090/Blackwell）
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt

# 2) 前端 CSS（开发时用 bun run css:watch）
bun install
bun run css:build

# 3) 起服务（首次加载模型约 58GB，需几分钟；精度用环境变量 KREA_PRECISION 指定）
.venv/bin/python -m uvicorn server.main:app --host 127.0.0.1 --port 8420
```

浏览器打开 <http://127.0.0.1:8420>。顶栏徽标显示「模型就绪」即可出图。

## 配置

模型路径硬编码在 `server/pipeline.py` 的 `MODEL_PATH`（默认 `/home/feifei/develop/models/Krea-2-Turbo`），改后重启即可。

## 结构

```
server/
  main.py        FastAPI 路由（status / presets / generate / tasks / images）
  pipeline.py    模型后台加载 + 单线程生成队列 + 步级进度
  presets.py     风格与比例预设
static/
  index.html     工作台界面（暗色，design-forge Signal 配方）
  app.js         状态轮询 / 画廊 / 灯箱
  css/src/       Tailwind v4 源 + forge-tokens.css（脚本生成）
  css/dist/      构建产物（不手改）
outputs/         生成图片 + json 元数据
```
