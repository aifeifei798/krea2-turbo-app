/* Krea 2 Turbo 工作台前端 · 基础层：共享状态、DOM/提示工具、视图切换、API 错误文案 */
"use strict";

export const $ = (id) => document.getElementById(id);

export const state = {
  styles: [], // {id, name, name_en, category, usage}
  roles: [], // {id, name, name_en, usage}
  selectedStyles: [], // 已选风格 id（有序，最多 MAX_STYLES 个）
  selectedRole: null, // 已选角色 id（单选，null = 无）
  pickerMode: null, // "style" | "role" | null（选择弹窗当前模式）
  pickerSelected: null, // 弹窗内的暂选（style: 数组 / role: id）
  aspects: [],
  maxSteps: 16,
  defaultSteps: 8,
  aspect: "1:1",
  mode: "t2i", // t2i 文生图 | i2i 图生图重绘
  commonWords: "", // 通用词：每次生成放在提示词最前（画质词等）
  initImage: null, // 参考图 base64（不含 data: 前缀）
  initThumb: null, // 参考图缩略 dataURL
  loras: [], // {id, name, filename, size_mb, on(=已加载), weight}
  selectedPrecision: "bf16",
  precisionHints: {},
  modelReady: false,
  modelState: null,
  modelPrecision: null,
  generating: false,
  activeTasks: {}, // taskId -> {shown(已上屏数), snippet}（任务队列）
  galleryTotal: 0, // 服务端作品总数（分页：本地只载窗口）
  galleryHasMore: false,
  loadingMore: false,
  currentTask: null,
  pollTimer: null,
  images: [],
};

/* ---------- 提示条 ---------- */

let toastTimer = null;
export function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.title = isError ? "点击复制错误信息" : "";
  el.classList.toggle("border-danger", isError);
  el.classList.toggle("text-danger", isError);
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  // 错误停留 10s 且可点击复制；普通消息 3.5s
  toastTimer = setTimeout(() => el.classList.add("hidden"), isError ? 10000 : 3500);
}

export function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
export const escapeAttr = escapeHTML;

/* ---------- 控制面板小工具（队列/面板共用） ---------- */

export const aspectClass = (on) =>
  `py-1.5 rounded-sm border font-mono text-xs transition-colors ${on
    ? "border-accent bg-accent-dim text-accent"
    : "border-border bg-panel text-muted hover:border-accent hover:text-ink"}`;

export function currentAspect() {
  return state.aspects.find((a) => a.id === state.aspect) || { width: 1024, height: 1024 };
}

/* 右侧签名数据块：实时参数回显 */
export function syncDataBlock() {
  const a = currentAspect();
  $("data-steps").textContent = $("steps").value;
  $("data-size").textContent = a.width === a.height ? `${a.width}²` : `${a.width}×${a.height}`;
  const seedVal = $("seed").value.trim();
  $("data-seed").textContent = seedVal === "" ? "auto" : seedVal;
}

/* ---------- 视图切换 ---------- */

export function switchView(view) {
  const isStudio = view === "studio";
  $("view-studio").classList.toggle("hidden", !isStudio);
  $("view-models").classList.toggle("hidden", isStudio);
  for (const btn of document.querySelectorAll("[data-view]")) {
    const on = btn.dataset.view === view;
    btn.setAttribute("aria-current", on ? "page" : "false");
    btn.classList.toggle("border-accent", on);
    btn.classList.toggle("text-accent", on);
    btn.classList.toggle("border-transparent", !on);
    btn.classList.toggle("text-muted", !on);
  }
}

export function bindNav() {
  document.querySelectorAll("[data-view]").forEach((btn) =>
    btn.addEventListener("click", () => switchView(btn.dataset.view)));
  $("lora-summary").addEventListener("click", () => switchView("models"));
}

/* ---------- FastAPI 校验错误（422 detail 数组）转可读中文 ---------- */

export const FIELD_NAMES = {
  prompt: "提示词", styles: "风格", role: "角色", aspect: "比例", steps: "步数",
  seed: "种子", batch: "批量", rounds: "次数", strength: "重绘幅度",
  init_image: "参考图", loras: "LoRA", weight: "强度",
};

export function friendlyApiError(err) {
  if (Array.isArray(err?.detail)) {
    return err.detail.map((d) => {
      const field = FIELD_NAMES[d.loc?.[1]] || d.loc?.[1] || "参数";
      const ctx = d.ctx || {};
      const rule = {
        less_than_equal: `不能超过 ${ctx.le}`,
        greater_than_equal: `不能小于 ${ctx.ge}`,
        string_too_long: `超过 ${ctx.max_length} 字`,
        string_too_short: `至少 ${ctx.min_length} 字`,
        too_long: `最多 ${ctx.max_length} 个`,
        too_short: `至少 ${ctx.min_length} 个`,
        missing: "缺少该参数",
        int_parsing: "需要是数字",
      }[d.type] || d.msg || "格式不正确";
      return `${field}${rule}`;
    }).join("；");
  }
  if (typeof err?.detail === "string") return err.detail;
  return `HTTP ${err?.status || ""}`.trim() || "未知错误";
}
