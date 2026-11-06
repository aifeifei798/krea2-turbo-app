"""模型管理：按精度构建/加载/卸载 Krea2 管线（fp8/int8/int4 量化与 bf16 offload）。"""

import gc
import logging
import os
import threading
from pathlib import Path

import torch

from . import lora, paths, state

logger = logging.getLogger("krea.pipeline")

_PRECISIONS = ("bf16", "fp8", "int8", "int4")

# 加载请求的原子占位：启动加载与 POST /api/model/load 共用，连点不会叠成两次重载
_load_lock = threading.Lock()
_load_inflight: str | None = None


def _quant_source(precision: str) -> Path:
    """该精度实际读取的目录：预量化目录（显式指定 > 同级约定）> 模型目录（现场量化）。"""
    return paths.get_quant_dir(precision) or paths.get_model_dir()

# 启动精度可用环境变量指定：KREA_PRECISION=bf16|fp8|int8|int4（server.sh 传入），默认 fp8
DEFAULT_PRECISION = os.environ.get("KREA_PRECISION", "fp8").strip().lower()
if DEFAULT_PRECISION not in _PRECISIONS:
    logger.warning("KREA_PRECISION=%s 无效，回退 fp8（可选 %s）",
                   DEFAULT_PRECISION, "/".join(_PRECISIONS))
    DEFAULT_PRECISION = "fp8"
PRECISION_HINTS = {
    "bf16": "全精度 · offload 模式，权重需 ~58GB 磁盘换页缓冲（RAM 紧张慎用），画质无损",
    "fp8": "transformer fp8(W8A8) + torch.compile 融合 · 全 GPU 常驻 ~16.7 GiB，"
           "出图最快（8 步约为 int8 的 1.7 倍），首次生成需预编译内核约 1 分钟",
    "int8": "transformer+编码器 torchao int8 · 全 GPU 常驻 ~16.7 GiB，出图约快 3 倍",
    "int4": "transformer+编码器 bnb nf4 · 全 GPU 常驻 ~9.9 GiB，最省显存，画质略降",
}


def compile_enabled() -> bool:
    """fp8 的 torch.compile 融合开关（默认开）。KREA_FP8_COMPILE=0 可退回 eager。"""
    return os.environ.get("KREA_FP8_COMPILE", "1").strip().lower() not in ("0", "false", "no")


def _build_pipe(precision: str):
    """按精度构建管线。量化精度（fp8/int8/int4）下 transformer 与文本编码器都量化；
    fp8 只量化 transformer（文本编码器只占约 48ms，没有 fp8 版本，复用 int8 权重）。
    diffusers 的 pipeline.to 会跳过带量化配置的组件，所以量化路径分组件加载、
    逐个显式上 GPU。模型目录取自 paths 配置（模型页可切换）。"""
    from diffusers import BitsAndBytesConfig, Krea2Pipeline, Krea2Transformer2DModel

    md = paths.get_model_dir()
    if precision == "bf16":
        pipe = Krea2Pipeline.from_pretrained(md, torch_dtype=torch.bfloat16)
        # 32GB 显存对 bf16 全量偏紧，offload 让子模型按需进出
        pipe.enable_model_cpu_offload()
        pipe.vae.enable_slicing()  # batch>1 时逐张解码，峰值显存降 1/N（输出等价）
        return pipe

    from diffusers import TorchAoConfig
    from torchao.quantization import Int8WeightOnlyConfig

    e_precision = "int8" if precision == "fp8" else precision  # 文本编码器用的量化
    if precision == "fp8":
        from torchao.quantization import Float8DynamicActivationFloat8WeightConfig
        t_cfg = TorchAoConfig(Float8DynamicActivationFloat8WeightConfig())
    elif precision == "int8":
        # torchao int8wo（bnb int8 与 torch 2.15 有 kernel 兼容 bug，实测失败）
        t_cfg = TorchAoConfig(Int8WeightOnlyConfig())
    elif precision == "int4":
        # bnb nf4：实测显存最低（9.9 GiB 常驻）且与 LoRA 兼容
        t_cfg = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                                   bnb_4bit_compute_dtype=torch.bfloat16)
    else:
        raise ValueError(f"未知精度: {precision}")

    if e_precision == "int4":
        from transformers import BitsAndBytesConfig as HFCfg
        e_cfg = HFCfg(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                      bnb_4bit_compute_dtype=torch.bfloat16)
    else:
        # 文本编码器走 transformers 加载路径，量化配置必须用 transformers 的类
        from transformers import TorchAoConfig as HFCfg
        e_cfg = HFCfg(Int8WeightOnlyConfig())

    # 预量化目录存在时直读（量化配置已嵌在组件 config.json 里，勿重复传）
    t_src = _quant_source(precision)
    e_src = _quant_source(e_precision)
    # 文本编码器要单独确认：fp8 目录只有 transformer，预量化目录也可能只导了一个组件
    if not (e_src / "text_encoder" / "config.json").exists():
        e_src = md
    from transformers import Qwen3VLModel
    if t_src != md:
        logger.info("precision %s: 读取预量化 transformer %s", precision, t_src)
        transformer = Krea2Transformer2DModel.from_pretrained(
            t_src, subfolder="transformer", torch_dtype=torch.bfloat16)
    else:
        transformer = Krea2Transformer2DModel.from_pretrained(
            md, subfolder="transformer", torch_dtype=torch.bfloat16,
            quantization_config=t_cfg)
    if e_src != md:
        logger.info("precision %s: 读取预量化 text_encoder %s", precision, e_src)
        text_encoder = Qwen3VLModel.from_pretrained(
            e_src, subfolder="text_encoder", torch_dtype=torch.bfloat16)
    else:
        text_encoder = Qwen3VLModel.from_pretrained(
            md, subfolder="text_encoder", torch_dtype=torch.bfloat16,
            quantization_config=e_cfg)
    pipe = Krea2Pipeline.from_pretrained(
        md, transformer=transformer, text_encoder=text_encoder,
        torch_dtype=torch.bfloat16)
    transformer.to("cuda")
    text_encoder.to("cuda")
    pipe.vae.to("cuda")
    # VAE 按 batch 逐张解码：batch=4 在 1216x832 会 OOM（要再挤 2.18 GiB），
    # 切片后峰值降到 1/N；与 tiling 不同，它不切空间维度，输出逐位等价。
    pipe.vae.enable_slicing()
    return pipe


def _install_compile(pipe) -> None:
    """给 transformer 装 torch.compile：融合激活量化/amax/cast/rope/norm 等逐元素算子。
    fp8 实测 670 → 448 ms/步（-33%），8 步 1216x832 从 6.4s 到 3.8s。
    dynamic=True 一次编译覆盖所有分辨率（static 每换一个尺寸要重编 40~60s）。
    只对 fp8 开：int8 权重走 torchao 自定义算子，实测编译 30 分钟不收敛。"""
    if not compile_enabled():
        logger.info("torch.compile 已按 KREA_FP8_COMPILE 关闭")
        return
    try:
        pipe.transformer.compile_repeated_blocks(fullgraph=True, dynamic=True)
    except Exception as exc:  # noqa: BLE001 - 编译不可用就安静退回 eager
        logger.warning("torch.compile 不可用，退回 eager：%s", exc)


def _warmup_compile() -> None:
    """后台把首次编译（约 1 分钟）跑在用户点生成之前。
    期间持有 model_lock：此时进来的任务照常排队，和「首次生成时现场编译」体验一致，
    但用户通常还在写提示词。编译的是「LoRA 常驻但禁用」这张图——生产默认状态。"""
    with state.model_lock:
        if state.pipe is None or state.MODEL_STATE.get("precision") != "fp8":
            return
        lora.sync_loras([])  # 常驻但去激活，与首个生成请求的行为一致
        base = state.MODEL_STATE["detail"]
        state.set_state("ready", f"{base} · 预编译内核中（首次约 1 分钟）")
        try:
            state.pipe(prompt="warmup", width=1024, height=1024,
                       num_inference_steps=1, guidance_scale=0.0,
                       num_images_per_prompt=1,
                       generator=torch.Generator(device="cuda").manual_seed(0))
            logger.info("fp8 预编译完成")
        except Exception:  # noqa: BLE001 - 预编译失败不影响后续按需编译
            logger.exception("fp8 预编译失败")
        finally:
            state.set_state("ready", base)


def _malloc_trim() -> None:
    """把 glibc 分配器滞留的空闲内存归还 OS。

    模型加载/卸载涉及数十 GB 的大块分配，glibc 默认不归还，
    多次切换精度后 RSS 只涨不跌，最终把 32GB RAM 吃满触发 OOM。"""
    try:
        import ctypes
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:  # noqa: BLE001 - 非 glibc 平台没有这个接口，忽略
        pass


def _unload_locked() -> None:
    lora._loaded_adapters.clear()
    if state.pipe is not None:
        state.pipe = None
        gc.collect()
        torch.cuda.empty_cache()
        _malloc_trim()
    state.set_state("unloaded", "未加载", precision=None, vram_gb=None)


def begin_load(precision: str) -> bool:
    """受理加载请求（原子占位）：成功 True，已有加载在途 False。
    占位到线程真正开跑之间有空档，靠这里一次性堵住连点导致的重复重载。"""
    global _load_inflight
    with _load_lock:
        if _load_inflight is not None:
            return False
        _load_inflight = precision
        return True


def request_load(precision: str) -> bool:
    """占位并起后台线程；已在加载返回 False（上层据此回 409）。"""
    if not begin_load(precision):
        return False
    threading.Thread(target=load_model, args=(precision,),
                     name="model-loader", daemon=True).start()
    return True


def load_model(precision: str) -> None:
    """按指定精度加载模型，随后全量常驻加载 LoRA（调方应放到后台线程）。"""
    global _load_inflight
    try:
        with state.model_lock:
            if state.MODEL_STATE["state"] == "loading":
                return
            _unload_locked()
            try:
                state.set_state("loading", f"正在按 {precision} 加载（首次需几分钟）…",
                                precision=precision)
                state.pipe = _build_pipe(precision)
                gc.collect()
                _malloc_trim()
                if paths.get_lora_autoload():
                    lora._load_all_loras_locked()  # 默认全量常驻；KREA_LORA_AUTLOAD=0 关闭
                # 编译必须装在 LoRA 注入之后：PEFT 会替换子模块，先编译会拿到失效引用
                if precision == "fp8":
                    _install_compile(state.pipe)
                if precision == "bf16":
                    detail = "bf16 · offload 模式（按需进出显存）"
                else:
                    vram = torch.cuda.memory_allocated() / 2**30
                    detail = f"{precision} · 常驻 {vram:.1f} GiB"
                state.set_state("ready", detail, precision=precision,
                                vram_gb=round(vram if precision != "bf16" else 0.0, 1))
            except Exception as exc:  # noqa: BLE001 - 加载失败细节透出给前端
                logger.exception("model load failed")
                state.pipe = None
                state.set_state("error", f"模型加载失败：{exc}", precision=precision)

        if precision == "fp8" and compile_enabled():
            # 锁外起线程：预编译约 1 分钟，不能算进「加载完成」；失败也不影响使用
            threading.Thread(target=_warmup_compile, name="fp8-warmup",
                             daemon=True).start()
    finally:
        with _load_lock:
            if _load_inflight == precision:
                _load_inflight = None


def unload_model(timeout: float = 5.0) -> None:
    """卸载模型。生成/加载中最多等 timeout 秒——HTTP 请求不能被一个长任务吊死，
    等不到就抛 RuntimeError，由上层回 409（与 LoRA 开关同一策略）。"""
    if not state.model_lock.acquire(timeout=timeout):
        busy = "模型正在加载" if state.MODEL_STATE["state"] == "loading" else "生成进行中"
        raise RuntimeError(f"{busy}，稍后再试")
    try:
        _unload_locked()
    finally:
        state.model_lock.release()


def get_model_state() -> dict:
    with state.lock:
        return dict(state.MODEL_STATE)


def get_precision_hints() -> dict:
    return PRECISION_HINTS
