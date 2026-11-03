#!/usr/bin/env node
// i18n 键完整性检查：JS 里 t("…") 与 HTML data-i18n* 的键必须都在 en.json（及其他语言包）里。
// 源语言是中文，所以只收含 CJK 的键（顺带滤掉 createElement("div") 这类正则噪音）。
// 用法: node scripts/check_i18n.mjs   —— 缺键时退出码 1。
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CJK = /[\u4e00-\u9fff]/;

const keys = new Set();
for (const f of readdirSync(join(root, "static", "js"))) {
  if (!f.endsWith(".js")) continue;
  const src = readFileSync(join(root, "static", "js", f), "utf8");
  for (const m of src.matchAll(/\bt\("([^"]+)"/g)) {
    if (CJK.test(m[1])) keys.add(m[1]);
  }
}
const html = readFileSync(join(root, "static", "index.html"), "utf8");
for (const m of html.matchAll(/data-i18n(?:-aria|-ph|-title|-alt)?="([^"]+)"/g)) {
  if (CJK.test(m[1])) keys.add(m[1]);
}

// 语言包本身无法静态提取的变量传参键（模式按钮、后端精度提示、示例提示词）
const variableKeys = new Set([
  "文生图", "图生图",  // renderMode 里 t(label) 变量传参
  "没有匹配的风格", "没有匹配的角色",  // t(isStyle ? … : …) 三元
  "API 密钥缺失或不正确",  // 后端 401 detail，前端直接展示
  "LoRA", "LoRA · {n}",  // 无 CJK 的恒等键，被 CJK 过滤器排除
  "BF16 全精度",
  "全精度 · offload 模式，权重需 ~58GB 磁盘换页缓冲（RAM 紧张慎用），画质无损",
  "transformer+编码器 torchao int8 · 全 GPU 常驻 ~16.7 GiB，出图约快 3 倍",
  "transformer+编码器 bnb nf4 · 全 GPU 常驻 ~9.9 GiB，最省显存，画质略降",
  "雨后深夜的小巷，霓虹灯牌倒映在积水路面，电影感",
  "一只柴犬坐在铺满银杏叶的台阶上，秋日午后暖光，写实摄影",
  "漂浮在云海之上的悬浮岛屿，水彩风格，柔和晨光",
]);

const en = JSON.parse(readFileSync(join(root, "static", "lang", "en.json"), "utf8"));
const missing = [...keys].filter((k) => !(k in en)).sort();
const extra = [...Object.keys(en)].filter((k) => !keys.has(k) && !variableKeys.has(k)).sort();

// 其余语言包：能解析 + 缺键统计（缺失回退中文，不算失败，只报告覆盖率）
const langDir = join(root, "static", "lang");
const index = JSON.parse(readFileSync(join(langDir, "index.json"), "utf8"));
const packProblems = [];
for (const { code } of index) {
  const p = join(langDir, `${code}.json`);
  if (code === "zh" || !existsSync(p)) continue;
  try {
    const pack = JSON.parse(readFileSync(p, "utf8"));
    const miss = [...keys].filter((k) => !(k in pack)).length;
    const cov = Math.round(((keys.size - miss) / keys.size) * 100);
    console.log(`  ${code}: 覆盖 ${cov}%（缺 ${miss} 条，回退中文）`);
  } catch (e) {
    packProblems.push(`${code}.json 解析失败: ${e.message}`);
  }
}
for (const { code } of index) {
  if (code !== "zh" && !existsSync(join(langDir, `${code}.json`))) {
    packProblems.push(`index.json 登记了 ${code} 但 ${code}.json 不存在`);
  }
}

console.log(`i18n: 界面键 ${keys.size} 条，en.json ${Object.keys(en).length} 条`);
if (missing.length) {
  console.log("缺失（必须补进 en.json）:");
  for (const k of missing) console.log("  MISSING:", k);
}
if (packProblems.length) for (const p of packProblems) console.log("  PROBLEM:", p);
if (extra.length) {
  console.log("en.json 疑似过期条目（界面里已找不到，确认后可删）:");
  for (const k of extra) console.log("  EXTRA:", k);
}
if (missing.length || packProblems.length) process.exit(1);
console.log("i18n OK ✓");
