/* 风格（多选）/角色（单选）选择弹窗 + 制作页摘要按钮 */
import { $, state, toast, escapeAttr } from "./core.js";
import { t } from "./i18n.js";
import { saveSettings } from "./settings.js";



/* 摘要按钮：多选高亮显数量，单选高亮显名字，悬停看明细 */
export function syncStyleSummary() {
  const names = state.selectedStyles
    .map((id) => state.styles.find((s) => s.id === id)?.name)
    .filter(Boolean);
  const el = $("style-summary");
  el.textContent = names.length ? t("风格 · {n}", { n: names.length }) : t("选择风格");
  el.classList.toggle("is-on", names.length > 0);
  el.title = names.length ? names.join(" · ") : t("可多选最多 4 个，弹窗里按使用频率排序");
  const role = state.selectedRole
    ? state.roles.find((r) => r.id === state.selectedRole) : null;
  const rel = $("role-summary");
  rel.textContent = role ? t("角色 · {s}", { s: role.name }) : t("选择角色");
  rel.classList.toggle("is-on", !!role);
  rel.title = role ? role.name : t("单选，弹窗里按使用频率排序");
}

export function openPicker(mode) {
  state.pickerMode = mode;
  state.pickerSelected = mode === "style" ? [...state.selectedStyles] : state.selectedRole;
  $("picker-title").textContent = mode === "style"
    ? t("选择风格（可多选，按使用频率排序）") : t("选择角色");
  $("picker-search").value = "";
  $("picker-clear").classList.toggle("hidden", mode !== "style");
  renderPickerList("");
  $("picker").classList.remove("hidden");
  $("picker-search").focus();
}

function closePicker() {
  $("picker").classList.add("hidden");
  state.pickerMode = null;
}

const pickerChipClass = (on) =>
  `px-2.5 py-1.5 rounded-sm border text-xs max-w-full truncate transition-colors ${on
    ? "border-accent bg-accent-dim text-accent"
    : "border-border bg-panel text-muted hover:border-accent hover:text-ink"}`;

function renderPickerList(query) {
  const q = query.trim().toLowerCase();
  const body = $("picker-body");
  body.innerHTML = "";
  const isStyle = state.pickerMode === "style";
  const all = isStyle ? state.styles : state.roles;
  const filtered = all.filter((it) => !q
    || it.name.toLowerCase().includes(q)
    || (it.name_en || "").toLowerCase().includes(q));

  const groups = new Map();
  const usedIds = new Set();
  if (isStyle && !q) {
    // 常用 TOP：用过的风格按次数排最前（分组后不再重复出现）
    const used = filtered.filter((s) => s.usage > 0);
    if (used.length) {
      groups.set(t("常用 TOP"), used);
      used.forEach((s) => usedIds.add(s.id));
    }
  }
  for (const it of filtered) {
    if (usedIds.has(it.id)) continue;
    const cat = isStyle ? (it.category || t("其他")) : t("全部角色");
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(it);
  }

  if (!filtered.length) {
    body.innerHTML = `<div class="py-16 text-center text-sm text-muted">${t(isStyle ? "没有匹配的风格" : "没有匹配的角色")}</div>`;
    updatePickerInfo();
    return;
  }
  for (const [cat, items] of groups) {
    const h = document.createElement("div");
    h.className = "text-xs font-mono text-muted mt-4 mb-1.5 first:mt-0";
    h.textContent = cat;
    body.appendChild(h);
    const wrap = document.createElement("div");
    wrap.className = "flex flex-wrap gap-1.5";
    items.forEach((it) => {
      const on = isStyle
        ? state.pickerSelected.includes(it.id)
        : state.pickerSelected === it.id;
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.id = it.id;
      b.title = `${it.name_en || it.name}${it.usage ? ` · ${t("已用 {n} 次", { n: it.usage })}` : ""}`;
      b.textContent = it.name;
      b.className = pickerChipClass(on);
      b.addEventListener("click", () => onPickerChip(it.id));
      wrap.appendChild(b);
    });
    body.appendChild(wrap);
  }
  updatePickerInfo();
}

function onPickerChip(id) {
  if (state.pickerMode === "role") {
    state.pickerSelected = state.pickerSelected === id ? null : id;
  } else {
    const sel = state.pickerSelected;
    const i = sel.indexOf(id);
    if (i >= 0) sel.splice(i, 1);
    else {
      if (sel.length >= state.maxStyles) {
        toast(t("最多同时选 {n} 个风格", { n: state.maxStyles }), true);
        return;
      }
      sel.push(id);
    }
  }
  // 原地更新选中态，避免重渲染导致滚动位置跳动
  document.querySelectorAll("#picker-body [data-id]").forEach((b) => {
    const on = state.pickerMode === "role"
      ? state.pickerSelected === b.dataset.id
      : state.pickerSelected.includes(b.dataset.id);
    b.className = pickerChipClass(on);
  });
  updatePickerInfo();
}

function updatePickerInfo() {
  const isStyle = state.pickerMode === "style";
  if (isStyle) {
    const names = state.pickerSelected
      .map((id) => state.styles.find((s) => s.id === id)?.name)
      .filter(Boolean);
    $("picker-info").textContent = names.length
      ? t("已选 {a}/{b}：{s}", { a: names.length, b: state.maxStyles, s: names.join(" · ") })
      : t("未选择（无风格）");
  } else {
    const r = state.roles.find((x) => x.id === state.pickerSelected);
    $("picker-info").textContent = r ? t("已选：{s}", { s: r.name }) : t("未选择（无角色）");
  }
}

function confirmPicker() {
  if (state.pickerMode === "style") state.selectedStyles = [...state.pickerSelected];
  else state.selectedRole = state.pickerSelected || null;
  syncStyleSummary();
  saveSettings();
  closePicker();
}

export function bindPicker() {
  $("style-summary").addEventListener("click", () => openPicker("style"));
  $("role-summary").addEventListener("click", () => openPicker("role"));
  $("picker-close").addEventListener("click", closePicker);
  $("picker").querySelector("[data-close]").addEventListener("click", closePicker);
  $("picker-ok").addEventListener("click", confirmPicker);
  $("picker-clear").addEventListener("click", () => {
    state.pickerSelected = state.pickerMode === "style" ? [] : null;
    renderPickerList($("picker-search").value);
  });
  $("picker-search").addEventListener("input", (e) => renderPickerList(e.target.value));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("picker").classList.contains("hidden")) closePicker();
  });
}

/* 语言切换：摘要按钮重渲染；弹窗开着时重渲染列表 */
document.addEventListener("langchange", () => {
  syncStyleSummary();
  if (!$("picker").classList.contains("hidden")) {
    renderPickerList($("picker-search").value);
  }
});
