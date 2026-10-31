"""CLI 冒烟测试：加载 Krea 2 Turbo，生成一张小图，记录显存与耗时。

用法：.venv/bin/python scripts/smoke_test.py
"""

import sys
import time
from pathlib import Path

import torch

MODEL_PATH = Path("/home/feifei/develop/models/Krea-2-Turbo")
OUT = Path(__file__).resolve().parent.parent / "outputs"
OUT.mkdir(exist_ok=True)


def main() -> int:
    from diffusers import Krea2Pipeline

    t0 = time.time()
    print(f"[{time.time()-t0:6.1f}s] loading pipeline (bf16)…")
    pipe = Krea2Pipeline.from_pretrained(MODEL_PATH, torch_dtype=torch.bfloat16)
    print(f"[{time.time()-t0:6.1f}s] from_pretrained done")

    pipe.enable_model_cpu_offload()
    print(f"[{time.time()-t0:6.1f}s] cpu_offload enabled")

    generator = torch.Generator(device="cuda").manual_seed(42)
    t1 = time.time()
    image = pipe(
        "a red fox sitting in fresh snow, golden hour, photorealistic",
        width=512,
        height=512,
        num_inference_steps=8,
        guidance_scale=0.0,
        generator=generator,
    ).images[0]
    dt = time.time() - t1

    peak = torch.cuda.max_memory_allocated() / 2**30
    out_path = OUT / "smoke_test.jpg"
    image.save(out_path, quality=95)
    print(f"[{time.time()-t0:6.1f}s] generated {image.size} in {dt:.1f}s, "
          f"VRAM peak {peak:.1f} GiB -> {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
