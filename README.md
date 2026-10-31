# Krea 2 Turbo 本地文生图工作台

基于 [Krea 2 Turbo](https://huggingface.co/krea/Krea-2-Turbo)（12B DiT 蒸馏文生图模型）的本地出图工作台：FastAPI 后端 + 原生 JS 前端 + Tailwind CSS v4。

![前端](static/favicon.svg)

## 特性

- **8 步蒸馏出图**：`guidance_scale=0.0`，RTX 5090 上 1024² 约几秒一张
- **LoRA 混合**：左面板启用任意多个 LoRA 并独立调强度（0–2），生成时增量加载/卸载，滑杆拖动即时生效
  - 自动兼容两种格式：diffusers PEFT 格式直载；ComfyUI/kohya 格式（`diffusion_model.` 前缀）自动把 `alpha` 标量按 `alpha/rank` 预乘进 `lora_B` 后加载
- **风格预设**：写实摄影 / 电影感 / 动漫 / 水墨 / 像素 / 低多边形 / 黑白 / 印象派 / 扁平海报
- **比例预设**：1:1、3:2、2:3、16:9、9:16（均为 16 像素倍数对齐）
- **步数 4–16、批量 1–4、seed 固定复现**
- **作品库**：落盘 `outputs/`（jpg + 同名 json 元数据，含 LoRA 参数），画廊 / 灯箱 / 下载 / 删除
- **模型 CPU offload**：12B DiT + Qwen3-VL 文本编码器按需进出 32GB 显存
- **双视图界面**：顶栏「制作 / 模型」切换 —— 制作页专注出图（LoRA 只留摘要条），模型页管理基础模型状态与 LoRA 开关/强度

> 注意：蒸馏模型 CFG 已关闭，**负面提示词无效**，所以界面没有这个输入。

## 启动

```bash
# 1) Python 环境（torch 需 cu128 及以上以支持 5090/Blackwell）
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt

# 2) 前端 CSS（开发时用 bun run css:watch）
bun install
bun run css:build

# 3) 起服务（首次加载模型约 58GB，需几分钟）
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
