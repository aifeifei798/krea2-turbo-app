"""风格与比例预设。

风格后缀参考 Krea 2 Turbo 官方示例提示词的写法（README widget），
拼接在用户提示词尾部；guidance_scale 固定 0.0（蒸馏模型，负面提示词无效）。
"""

STYLES = [
    {"id": "none", "name": "自由发挥", "suffix": ""},
    {"id": "photo", "name": "写实摄影", "suffix": "photorealistic, shot on 35mm film, natural lighting, fine detail"},
    {"id": "cinema", "name": "电影感", "suffix": "cinematic still, dramatic lighting, film grain, anamorphic lens, shallow depth of field"},
    {"id": "anime", "name": "动漫", "suffix": "anime illustration, clean line art, vibrant colors, cel shading"},
    {"id": "ink", "name": "水墨", "suffix": "Chinese ink wash painting, sumi-e style, minimal composition, rice paper texture"},
    {"id": "pixel", "name": "像素", "suffix": "retro pixel art, 16-bit style, limited color palette, blocky shapes"},
    {"id": "lowpoly", "name": "低多边形", "suffix": "low-poly 3D render, flat shading, geometric shapes"},
    {"id": "mono", "name": "黑白", "suffix": "black and white photography, high contrast, monochrome, strong shadows"},
    {"id": "impression", "name": "印象派", "suffix": "impressionist painting, visible brushstrokes, soft pastel palette"},
    {"id": "poster", "name": "扁平海报", "suffix": "flat vector illustration, bold shapes, poster design, minimal palette"},
]

# 尺寸均为 16 的倍数（VAE 8x 下采样 × patch 2 对齐）
ASPECTS = [
    {"id": "1:1", "name": "1:1 方形", "width": 1024, "height": 1024},
    {"id": "3:2", "name": "3:2 横幅", "width": 1216, "height": 832},
    {"id": "2:3", "name": "2:3 竖幅", "width": 832, "height": 1216},
    {"id": "16:9", "name": "16:9 宽屏", "width": 1344, "height": 768},
    {"id": "9:16", "name": "9:16 全屏", "width": 768, "height": 1344},
]

DEFAULT_STEPS = 8          # 蒸馏版推荐步数
MAX_STEPS = 16             # 超过收益很低
MAX_BATCH = 4
MAX_ROUNDS = 8             # 「次数」：每轮独立跑一次管线（每轮 batch 张）


def get_style(style_id: str) -> dict:
    return next((s for s in STYLES if s["id"] == style_id), STYLES[0])


def get_aspect(aspect_id: str) -> dict:
    return next((a for a in ASPECTS if a["id"] == aspect_id), ASPECTS[0])
