"""共享运行时状态：管线实例、模型状态、任务表与锁。

模型加载（model.py）、LoRA 管理（lora.py）、生成任务（tasks.py）都围绕这里的
同一份状态工作；本模块只存状态不装逻辑，是依赖图的叶子，谁都可以安全导入。
"""

import logging
import queue
import threading
import time
from dataclasses import dataclass, field

logger = logging.getLogger("krea.pipeline")

# state ∈ unloaded | loading | ready | error
MODEL_STATE = {"state": "unloaded", "detail": "未加载",
               "precision": None, "vram_gb": None}

pipe = None  # Krea2Pipeline 实例：仅 model.py 整体替换，lora/tasks 只读
gen_queue: "queue.Queue[dict]" = queue.Queue()
lock = threading.Lock()          # 保护 TASKS / MODEL_STATE 的并发读写
model_lock = threading.RLock()   # 模型与 LoRA 装卸互斥（可重入）

TASKS: dict[str, dict] = {}
TASK_TTL = 3600  # 完成任务保留 1 小时供前端查询


@dataclass
class GenRequest:
    task_id: str
    prompt: str
    styles: list[str] = field(default_factory=list)  # 风格 id，按选择顺序嵌套模板
    role: str | None = None  # 角色 id（单选）
    aspect_id: str = "1:1"
    steps: int = 8
    seed: int | None = None
    batch: int = 1
    rounds: int = 1  # 跑几轮：每轮独立管线调用（batch 张/轮），种子逐轮 +1
    common: str = ""  # 通用词：放在提示词最前（画质词等，每次生成都带）
    init_image: str | None = None  # base64 参考图（有值 = 图生图重绘）
    mask_image: str | None = None  # base64 蒙版（白=重绘）：有值 = 局部重绘
    strength: float = 0.6  # 重绘幅度 0-1：越大越偏离原图（局部重绘只作用于涂抹区）
    loras: list[tuple[str, float]] = field(default_factory=list)  # (lora_id, weight)
    source_id: str | None = None  # 局部重绘的源图 id（灯箱送修图时带上，供前后对比）
    created_at: float = field(default_factory=time.time)


def set_state(state: str, detail: str, **extra) -> None:
    with lock:
        MODEL_STATE["state"] = state
        MODEL_STATE["detail"] = detail
        MODEL_STATE.update(extra)
    logger.info("model state: %s - %s %s", state, detail, extra)


def prune_tasks() -> None:
    """清理过期任务（done/error 且超过 TTL）。调用方持有 lock。"""
    now = time.time()
    for tid in [t for t, v in TASKS.items() if v["state"] in ("done", "error")
                and now - v.get("finished_at", 0) > TASK_TTL]:
        TASKS.pop(tid, None)
