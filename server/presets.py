"""风格/角色/比例预设 + 使用频率统计。

风格数据来自 scripts/port_presets.py 转换的历史预设（server/style_data.py），
旧内置 10 个中文风格并入「常用」分类且 id 不变。negative_prompt 在本模型
（CFG=0 蒸馏，负面提示词无效）不生效，数据保留备用。
"""

import json
import threading
from pathlib import Path

from .juese_data import ROLES as _ROLE_DATA
from .style_data import STYLES as _IMPORTED_STYLES

BASE_DIR = Path(__file__).resolve().parent.parent

STYLES = [
    {"id": "none", "name": "自由发挥", "name_en": "none", "category": "常用",
     "template": "{prompt}", "negative_prompt": ""},
    {"id": "photo", "name": "写实摄影", "name_en": "photo", "category": "常用",
     "template": "{prompt}, photorealistic, shot on 35mm film, natural lighting, fine detail",
     "negative_prompt": ""},
    {"id": "cinema", "name": "电影感", "name_en": "cinema", "category": "常用",
     "template": "{prompt}, cinematic still, dramatic lighting, film grain, anamorphic lens, shallow depth of field",
     "negative_prompt": ""},
    {"id": "anime", "name": "动漫", "name_en": "anime", "category": "常用",
     "template": "{prompt}, anime illustration, clean line art, vibrant colors, cel shading",
     "negative_prompt": ""},
    {"id": "ink", "name": "水墨", "name_en": "ink", "category": "常用",
     "template": "{prompt}, Chinese ink wash painting, sumi-e style, minimal composition, rice paper texture",
     "negative_prompt": ""},
    {"id": "pixel", "name": "像素", "name_en": "pixel", "category": "常用",
     "template": "{prompt}, retro pixel art, 16-bit style, limited color palette, blocky shapes",
     "negative_prompt": ""},
    {"id": "lowpoly", "name": "低多边形", "name_en": "lowpoly", "category": "常用",
     "template": "{prompt}, low-poly 3D render, flat shading, geometric shapes",
     "negative_prompt": ""},
    {"id": "mono", "name": "黑白", "name_en": "mono", "category": "常用",
     "template": "{prompt}, black and white photography, high contrast, monochrome, strong shadows",
     "negative_prompt": ""},
    {"id": "impression", "name": "印象派", "name_en": "impression", "category": "常用",
     "template": "{prompt}, impressionist painting, visible brushstrokes, soft pastel palette",
     "negative_prompt": ""},
    {"id": "poster", "name": "扁平海报", "name_en": "poster", "category": "常用",
     "template": "{prompt}, flat vector illustration, bold shapes, poster design, minimal palette",
     "negative_prompt": ""},
]
STYLES += [s for s in _IMPORTED_STYLES if s["id"] != "none"]  # 无风格用内置「自由发挥」

ROLES = list(_ROLE_DATA)

# 尺寸均为 16 的倍数（VAE 8x 下采样 × patch 2 对齐），总像素贴近 1024²
ASPECTS = [
    {"id": "1:1", "name": "1:1 方形", "width": 1024, "height": 1024},
    {"id": "3:2", "name": "3:2 横幅", "width": 1216, "height": 832},
    {"id": "2:3", "name": "2:3 竖幅", "width": 832, "height": 1216},
    {"id": "16:9", "name": "16:9 宽屏", "width": 1344, "height": 768},
    {"id": "9:16", "name": "9:16 全屏", "width": 768, "height": 1344},
    {"id": "2:1", "name": "2:1 超宽", "width": 1344, "height": 672},
    {"id": "1:2", "name": "1:2 超长", "width": 672, "height": 1344},
]

DEFAULT_STEPS = 8          # 蒸馏版推荐步数
MAX_STEPS = 16             # 超过收益很低
MAX_BATCH = 4
MAX_ROUNDS = 8             # 「次数」：每轮独立跑一次管线（每轮 batch 张）
MAX_STYLES = 4             # 风格多选上限（模板嵌套过深提示词会糊）

_style_map = {s["id"]: s for s in STYLES}
_role_map = {r["id"]: r for r in ROLES}


def get_style(style_id: str) -> dict:
    return _style_map.get(style_id, _style_map["none"])


def get_aspect(aspect_id: str) -> dict:
    return next((a for a in ASPECTS if a["id"] == aspect_id), ASPECTS[0])


def get_role(role_id: str | None) -> dict | None:
    if not role_id:
        return None
    return _role_map.get(role_id)


# ---------------------------------------------------------------- 使用频率

_usage_lock = threading.Lock()
_usage_path = BASE_DIR / ".usage.json"
_usage_cache: dict | None = None


def _load_usage() -> dict:
    global _usage_cache
    if _usage_cache is None:
        try:
            _usage_cache = json.loads(_usage_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            _usage_cache = {}
    return _usage_cache


def record_usage(style_ids: list[str], role_id: str | None) -> None:
    """任务成功后计一次使用量（按任务计，不按张数），原子落盘。"""
    with _usage_lock:
        u = _load_usage()
        for sid in style_ids:
            u[f"style:{sid}"] = u.get(f"style:{sid}", 0) + 1
        if role_id:
            u[f"role:{role_id}"] = u.get(f"role:{role_id}", 0) + 1
        tmp = _usage_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(u, ensure_ascii=False), encoding="utf-8")
        tmp.replace(_usage_path)


def get_presets() -> dict:
    """给前端的预设：风格/角色带使用次数，常用（用过的）排最前。
    角色的「无」固定首位（单选的空选项），其余按用量排序。"""
    u = _load_usage()
    styles = [{**s, "usage": u.get(f"style:{s['id']}", 0)}
              for s in STYLES if s["id"] != "none"]
    styles.sort(key=lambda s: -s["usage"])   # 稳定排序：未用过的保持原序
    roles = sorted(({**r, "usage": u.get(f"role:{r['id']}", 0)}
                    for r in ROLES if r["id"] != "none"),
                   key=lambda r: -r["usage"])
    roles.insert(0, {**_role_map["none"], "usage": 0})
    return {"styles": styles, "roles": roles, "aspects": ASPECTS,
            "default_steps": DEFAULT_STEPS, "max_steps": MAX_STEPS,
            "max_styles": MAX_STYLES}
