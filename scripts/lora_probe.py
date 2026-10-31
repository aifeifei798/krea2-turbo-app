"""LoRA 加载实测：
1. FeiFei（diffusers PEFT 格式）直接 load
2. Cc（ComfyUI 格式带 gate.alpha 标量）→ alpha 并入 lora_B 后 load
3. set_adapters 动态调强弱
4. 出图验证

用法：.venv/bin/python scripts/lora_probe.py
"""

import time
from pathlib import Path

import torch
from safetensors.torch import load_file

MODEL_PATH = Path("/home/feifei/develop/models/Krea-2-Turbo")
LORA_DIR = MODEL_PATH / "loras"
OUT = Path(__file__).resolve().parent.parent / "outputs"


def merge_comfyui_alphas(state_dict: dict) -> dict:
    """kohya 系训练器把每个模块的 alpha 存成独立标量，diffusers 转换器
    只认 lora_A/B 对、见到剩余 key 会 raise。数学等价处理：
    effective_scale = alpha / rank，把 scale 预乘进 lora_B，然后丢掉 alpha。"""
    for key in [k for k in list(state_dict) if k.endswith(".alpha")]:
        module = key[: -len(".alpha")]
        lora_a = f"{module}.lora_A.weight"
        lora_b = f"{module}.lora_B.weight"
        if lora_a not in state_dict or lora_b not in state_dict:
            print(f"  !! alpha 无配对 lora，丢弃: {key}")
            state_dict.pop(key)
            continue
        rank = state_dict[lora_a].shape[0]
        alpha = state_dict.pop(key).item()
        scale = alpha / rank
        state_dict[lora_b] = state_dict[lora_b] * scale
        print(f"  alpha {alpha:.1f} / rank {rank} = scale {scale:.4f} -> {module}")
    return state_dict


def main() -> None:
    from diffusers import Krea2Pipeline

    t0 = time.time()
    pipe = Krea2Pipeline.from_pretrained(MODEL_PATH, torch_dtype=torch.bfloat16)
    pipe.enable_model_cpu_offload()
    print(f"[{time.time()-t0:5.1f}s] pipeline ready")

    # 1) diffusers 格式直接 load
    pipe.load_lora_weights(str(LORA_DIR / "FeiFei_c1-st2000.safetensors"),
                           adapter_name="feifei")
    print(f"[{time.time()-t0:5.1f}s] feifei loaded")

    # 2) ComfyUI 格式 + alpha 预处理
    sd = load_file(str(LORA_DIR / "krea2-Cc风情万种-风格.safetensors"))
    sd = merge_comfyui_alphas(sd)
    pipe.load_lora_weights(sd, adapter_name="cc_style")
    print(f"[{time.time()-t0:5.1f}s] cc_style loaded (alpha merged)")

    # 3) 动态权重
    pipe.set_adapters(["feifei", "cc_style"], adapter_weights=[0.8, 1.2])
    print(f"[{time.time()-t0:5.1f}s] adapters set (0.8 / 1.2)")

    # 4) 出图
    generator = torch.Generator(device="cuda").manual_seed(7)
    img = pipe("a cozy reading nook by a rainy window, warm lamp light",
               width=512, height=512, num_inference_steps=8,
               guidance_scale=0.0, generator=generator).images[0]
    img.save(OUT / "lora_probe.jpg", quality=95)
    peak = torch.cuda.max_memory_allocated() / 2**30
    print(f"[{time.time()-t0:5.1f}s] generated, VRAM peak {peak:.1f} GiB")

    # 5) 权重热调 + 卸载验证
    pipe.set_adapters(["feifei", "cc_style"], adapter_weights=[0.3, 0.5])
    print(f"[{time.time()-t0:5.1f}s] re-set weights OK")
    pipe.delete_adapters(["feifei", "cc_style"])
    print(f"[{time.time()-t0:5.1f}s] adapters deleted OK")


if __name__ == "__main__":
    main()
