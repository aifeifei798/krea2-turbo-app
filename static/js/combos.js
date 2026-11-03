/* 风格方案：把 风格组合 + 角色 + 通用词 打包存成一键方案（localStorage 持久化） */
import { $, state, toast, escapeHTML } from "./core.js";
import { saveSettings } from "./settings.js";
import { syncStyleSummary } from "./picker.js";
import { syncCommonBadge } from "./common-words.js";

const COMBOS_KEY = "krea2-combos-v1";

const loadCombos = () => {
  try {
    const v = JSON.parse(localStorage.getItem(COMBOS_KEY));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

const persistCombos = (list) => {
  try {
    localStorage.setItem(COMBOS_KEY, JSON.stringify(list));
  } catch { /* 隐私模式等存不进就算了 */ }
};

/* 入口按钮：有方案时高亮显数量 */
export function syncComboBadge() {
  const n = loadCombos().length;
  const btn = $("combo-btn");
  btn.textContent = n ? `方案 · ${n}` : "方案";
  btn.classList.toggle("is-on", n > 0);
}

function comboHint(c) {
  const role = c.role ? ` · 角色` : "";
  return `${(c.styles || []).length} 个风格${role}${c.common ? " · 通用词" : ""}`;
}

function openComboDialog() {
  $("combo-name").value = "";
  renderComboList();
  $("combo-dialog").classList.remove("hidden");
  $("combo-name").focus();
}

function closeComboDialog() {
  $("combo-dialog").classList.add("hidden");
}

function renderComboList() {
  const list = loadCombos();
  const box = $("combo-list");
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = `<div class="py-8 text-center text-sm text-muted">还没有方案：配好风格/角色/通用词后，起个名字保存</div>`;
    syncComboBadge();
    return;
  }
  list.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "flex items-center gap-2 border border-border rounded-md bg-panel px-2.5 py-2";
    row.innerHTML = `
      <button type="button" data-apply="${i}" class="flex-1 min-w-0 text-left" title="点击套用">
        <div class="text-sm truncate">${escapeHTML(c.name)}</div>
        <div class="text-xs font-mono text-muted truncate">${escapeHTML(comboHint(c))}</div>
      </button>
      <button type="button" data-del="${i}" aria-label="删除方案"
        class="shrink-0 w-6 h-6 rounded-sm border border-border text-muted hover:text-danger hover:border-danger transition-colors text-sm leading-none">×</button>`;
    row.querySelector("[data-apply]").addEventListener("click", () => applyCombo(i));
    row.querySelector("[data-del]").addEventListener("click", () => {
      const name = loadCombos()[i]?.name;
      persistCombos(loadCombos().filter((_, k) => k !== i));
      renderComboList();
      toast(`方案「${name}」已删除`);
    });
    box.appendChild(row);
  });
  syncComboBadge();
}

function saveCurrentCombo() {
  const name = $("combo-name").value.trim();
  if (!name) { toast("先给方案起个名字", true); return; }
  if (!state.selectedStyles.length && !state.selectedRole && !state.commonWords) {
    toast("当前没有可保存的选择", true);
    return;
  }
  const list = loadCombos();
  const entry = {
    name,
    styles: [...state.selectedStyles],
    role: state.selectedRole,
    common: state.commonWords,
  };
  const i = list.findIndex((c) => c.name === name);
  if (i >= 0) list[i] = entry;
  else list.push(entry);
  persistCombos(list);
  renderComboList();
  toast(i >= 0 ? `方案「${name}」已更新` : `方案「${name}」已保存`);
}

function applyCombo(i) {
  const c = loadCombos()[i];
  if (!c) return;
  state.selectedStyles = (c.styles || []).filter(
    (id) => state.styles.some((s) => s.id === id));
  state.selectedRole =
    c.role && state.roles.some((r) => r.id === c.role) ? c.role : null;
  state.commonWords = c.common || "";
  syncStyleSummary();
  syncCommonBadge();
  saveSettings();
  closeComboDialog();
  toast(`已应用方案「${c.name}」`);
}

export function bindCombos() {
  $("combo-btn").addEventListener("click", openComboDialog);
  $("combo-close").addEventListener("click", closeComboDialog);
  $("combo-dialog").querySelector("[data-close]").addEventListener("click", closeComboDialog);
  $("combo-save").addEventListener("click", saveCurrentCombo);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("combo-dialog").classList.contains("hidden")) {
      closeComboDialog();
    }
  });
  syncComboBadge();
}
