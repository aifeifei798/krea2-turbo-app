/* i18n：中文为源语言，语言包是 static/lang/{code}.json（{"中文原句": "译文"}）。
   新增语言：复制 en.json 逐条翻译值 → 在 static/lang/index.json 登记一行，右上角即出现。
   静态文案用 data-i18n（文本）/ data-i18n-aria / data-i18n-ph / data-i18n-title / data-i18n-alt 标记；
   JS 动态文案 import { t } 包裹；语言切换后广播 langchange 事件，各模块自行重渲染。
   本模块不依赖 core（叶子模块）：core 也要用 t，依赖必须保持单向。 */

const LANG_KEY = "krea2-lang";
let dict = {}; // 当前语言映射（zh 恒为空 = 原文直出）
let current = "zh";
let langs = [{ code: "zh", name: "中文" }]; // index.json 拉取失败时的兜底

/* 翻译：取当前语言映射，缺条目回退原文；{x} 占位符用 params 替换 */
export function t(s, params) {
  let out = dict[s] ?? s;
  if (params) {
    for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

export const getLang = () => current;
export const getLangs = () => langs;

export async function initI18n() {
  try {
    const list = await fetch("/lang/index.json").then((r) => r.json());
    if (Array.isArray(list) && list.some((l) => l.code === "zh")) langs = list;
  } catch { /* 语言清单拉不到就用内置兜底 */ }
  current = localStorage.getItem(LANG_KEY) || "zh";
  if (!langs.some((l) => l.code === current)) current = "zh";
  await loadDict(current);
}

async function loadDict(code) {
  if (code === "zh") { dict = {}; return; }
  try {
    dict = await fetch(`/lang/${encodeURIComponent(code)}.json`).then((r) => r.json());
  } catch { dict = {}; } // 拉不到该语言包：整包回退中文
}

/* 应用静态 DOM：按 data-* 标记把原文替换为译文 */
export function applyStatic(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nAria));
  });
  root.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  root.querySelectorAll("[data-i18n-alt]").forEach((el) => { el.alt = t(el.dataset.i18nAlt); });
  document.title = t("Krea 2 Turbo 工作台");
  document.documentElement.lang = current === "zh" ? "zh-CN" : current;
}

/* 切换语言：持久化 → 换语言包 → 重渲染静态 DOM → 广播 langchange */
export async function setLang(code) {
  if (code === current || !langs.some((l) => l.code === code)) return;
  current = code;
  try { localStorage.setItem(LANG_KEY, code); } catch { /* 存不进就算了 */ }
  await loadDict(code);
  applyStatic();
  document.dispatchEvent(new CustomEvent("langchange"));
}

/* 右上角语言切换器：选项来自 index.json（他人加语言自动出现） */
export function bindLangSelect() {
  const sel = document.getElementById("lang-select");
  if (!sel) return;
  sel.innerHTML = "";
  langs.forEach((l) => {
    const o = document.createElement("option");
    o.value = l.code;
    o.textContent = l.name;
    sel.appendChild(o);
  });
  sel.value = current;
  sel.addEventListener("change", () => setLang(sel.value));
  document.addEventListener("langchange", () => { sel.value = current; });
}
