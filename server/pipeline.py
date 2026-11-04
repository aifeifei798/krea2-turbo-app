"""Krea 2 Turbo 管线门面。

实现按职责拆分，main.py 一律 import pipeline（本文件），内部结构不外泄：

- state.py  —— 共享运行时状态（管线实例 / 模型状态 / 任务表 / 锁），依赖图叶子
- model.py  —— 模型加载 / 卸载 / 精度切换（bf16 offload、int8/int4 量化）
- lora.py   —— LoRA 常驻管理（默认全量加载、ComfyUI 格式兼容、生成前对齐）
- tasks.py  —— 图像编码（SDEdit / 修图）、单线程生成 worker、任务队列与落盘

依赖单向：tasks → {model, lora} → state；lora 与 model 之间经 state 解耦不互相依赖。
"""

from .lora import (DEFAULT_LORA_WEIGHT, list_loras, sync_loras,
                   toggle_lora)
from .model import (DEFAULT_PRECISION, get_model_state,
                    get_precision_hints, load_model, unload_model)
from .tasks import (ImageLimitError, _decode_image_b64, _image_size_b64,
                    cancel_task, enqueue, get_task, start_background)

__all__ = [
    "DEFAULT_LORA_WEIGHT", "DEFAULT_PRECISION",
    "load_model", "unload_model", "get_model_state", "get_precision_hints",
    "list_loras", "toggle_lora", "sync_loras",
    "start_background", "enqueue", "get_task", "cancel_task",
    "_decode_image_b64", "_image_size_b64", "ImageLimitError",
]
