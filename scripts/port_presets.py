"""把早期角色/风格预设数据（develop/app/tmp/*.py）转换进项目。

- 风格 794 条：中文名（aliases 缺失时用原名）、原始英文名、分类（源码小节注释）、
  {prompt} 模板、negative_prompt（本模型 CFG=0 不生效，仅保留数据）
- 角色 56 条：中文名（仅 5 条有别名，其余保留原名——多为专有人名）、原始名、描述
- id = sha1(原始名)[:8]，跨版本稳定；"(None)" 固定 id="none"

用法: .venv/bin/python scripts/port_presets.py
产物: server/style_data.py / server/juese_data.py（可重复运行覆盖）
"""

import hashlib
import re
from pathlib import Path

import sys

sys.path.insert(0, "/home/feifei/develop/app/tmp")
import juese_data  # noqa: E402
import style_data  # noqa: E402

TMP = Path("/home/feifei/develop/app/tmp")
OUT = Path(__file__).resolve().parent.parent / "server"

CATEGORY_ZH = {
    "Signature Lighting": "光影",
    "Photography & Film Stocks": "摄影与胶片",
    "Art & Illustration Styles": "艺术与插画",
    "Fashion & Outfit Vibe": "时尚与穿搭",
    "Famous Directors & Cinema": "导演与电影",
    "Seasons & Weather": "季节与天气",
    "Creative & Effects": "创意与特效",
    "Camera Angles": "镜头与机位",
}
SKIP_HEADER_PAT = re.compile(
    r"(Style template|Character template|To add an entry|\"name\": shown|"
    r"\"prompt\": positive|negative\"|template\.|\"negative_prompt\"|must be kept|"
    r"style_selector_node|Legacy Chinese|older workflows)")
EMOJI_PAT = re.compile(r"^[\U0001F000-\U0001FAFF\u2600-\u27BF\uFE0F\s]+")


def section_categories(path: Path) -> dict[str, str]:
    """扫描源码行，把每个 '"name"' 行归入其上方最近的小节注释分类。

    源文件只有前段有小节注释；最后一个小节之后没有边界标记（后续是长期
    追加的无分类大块），而其余小节恰好各 10 条，因此最后一个小节只收 10 条，
    其后全部归「更多」。"""
    lines = path.read_text(encoding="utf-8").splitlines()
    headers: list[tuple[int, str]] = []  # (行号, 分类)
    for i, line in enumerate(lines):
        s = line.strip()
        if s.startswith("#"):
            t = s.lstrip("# ").strip()
            if not t or set(t) <= {"=", "-"} or SKIP_HEADER_PAT.search(t):
                continue
            headers.append((i, EMOJI_PAT.sub("", t) or "其他"))

    cats: dict[str, str] = {}
    since_last = 0
    last_line = headers[-1][0] if headers else -1
    for i, line in enumerate(lines):
        if '"name"' not in line:
            continue
        m = re.search(r'"name":\s*"((?:[^"\\]|\\.)*)"', line)
        if not m:
            continue
        if headers and i > last_line:
            since_last += 1
            cats[m.group(1)] = "更多" if since_last > 10 else headers[-1][1]
            continue
        cat = "其他"
        for h_line, h_cat in headers:
            if h_line < i:
                cat = h_cat
            else:
                break
        cats[m.group(1)] = cat
    return cats


def sid(name: str) -> str:
    return "none" if name == "(None)" else hashlib.sha1(name.encode()).hexdigest()[:8]


def main() -> None:
    style_cats = section_categories(TMP / "style_data.py")
    zh_of_style = {v: k for k, v in style_data.style_name_aliases.items()}
    zh_of_role = {v: k for k, v in juese_data.juese_name_aliases.items()}

    styles = []
    for s in style_data.style_list:
        name_en = s["name"]
        name = zh_of_style.get(name_en, name_en)
        cat = style_cats.get(name_en) or "其他"
        styles.append({
            "id": sid(name_en),
            "name": "无" if name_en == "(None)" else name,
            "name_en": name_en,
            "category": CATEGORY_ZH.get(cat, cat),
            "template": s["prompt"],
            "negative_prompt": s.get("negative_prompt", ""),
        })

    roles = []
    for j in juese_data.juese_list:
        name_en = j["name"]
        roles.append({
            "id": sid(name_en),
            "name": "无" if name_en == "(None)" else zh_of_role.get(name_en, name_en),
            "name_en": name_en,
            "prompt": j["prompt"],
        })

    (OUT / "style_data.py").write_text(
        '"""风格预设数据（由 scripts/port_presets.py 生成，勿手改；改数据后重跑脚本）。\n\n'
        'name=中文显示名（缺省用原名），name_en=原始名（搜索用），template 含 {prompt} 占位，\n'
        'negative_prompt 在本模型（CFG=0 蒸馏）不生效，仅保留数据备用。\n"""\n\n'
        + f"STYLES = {styles!r}\n", encoding="utf-8")
    (OUT / "juese_data.py").write_text(
        '"""角色预设数据（由 scripts/port_presets.py 生成，勿手改）。\n\n'
        '角色多为专有人名，无中文别名时保留原名显示。"""\n\n'
        + f"ROLES = {roles!r}\n", encoding="utf-8")
    print(f"styles: {len(styles)} 条（分类 {len({s['category'] for s in styles})} 个）")
    print(f"roles: {len(roles)} 条")
    assert styles[0]["id"] == "none" and roles[0]["id"] == "none"


if __name__ == "__main__":
    main()
