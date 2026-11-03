/* 通用词：放在每次生成提示词最前的画质/质量词，弹窗编辑 + 快捷词 */
import { $, state, toast } from "./core.js";
import { saveSettings } from "./settings.js";

const COMMON_PRESETS = [
  "masterpiece, best quality",
  "ultra detailed, 8k",
  "delicate face, detailed eyes",
  "perfect anatomy",
  "cinematic composition",
];

const commonWordsCount = (v) =>
  v.trim() ? v.split(/[,，;；]/).filter((s) => s.trim()).length : 0;

/* 入口按钮：已填写时高亮并显示词数 */
export function syncCommonBadge() {
  const btn = $("common-btn");
  const on = !!state.commonWords;
  const n = commonWordsCount(state.commonWords);
  btn.textContent = on ? `通用词 ${n}` : "通用词";
  btn.classList.toggle("text-accent", on);
  btn.classList.toggle("border-accent", on);
}

function openCommonDialog() {
  $("common-text").value = state.commonWords;
  renderCommonChips();
  updateCommonInfo();
  $("common-dialog").classList.remove("hidden");
  $("common-text").focus();
}

function closeCommonDialog() {
  $("common-dialog").classList.add("hidden");
}

function renderCommonChips() {
  const box = $("common-chips");
  box.innerHTML = "";
  COMMON_PRESETS.forEach((words) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = words;
    b.title = "点击追加";
    b.className = "px-2 py-1 rounded-sm border border-border bg-panel text-xs text-muted hover:border-accent hover:text-ink transition-colors";
    b.addEventListener("click", () => {
      const cur = $("common-text").value.trim().replace(/[,;\s]+$/, "");
      $("common-text").value = cur ? `${cur}, ${words}` : words;
      updateCommonInfo();
    });
    box.appendChild(b);
  });
}

function updateCommonInfo() {
  const v = $("common-text").value.trim();
  const n = commonWordsCount(v);
  $("common-info").textContent = n ? `${n} 个词，将放在提示词最前` : "未填写";
}

function saveCommonWords() {
  const v = $("common-text").value.trim().replace(/[,;\s]+$/, "");
  state.commonWords = v;
  saveSettings();
  syncCommonBadge();
  closeCommonDialog();
  toast(v ? "通用词已保存，将放在提示词最前" : "通用词已清空");
}

export function bindCommonDialog() {
  $("common-btn").addEventListener("click", openCommonDialog);
  $("common-close").addEventListener("click", closeCommonDialog);
  $("common-dialog").querySelector("[data-close]").addEventListener("click", closeCommonDialog);
  $("common-save").addEventListener("click", saveCommonWords);
  $("common-text").addEventListener("input", updateCommonInfo);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("common-dialog").classList.contains("hidden")) {
      closeCommonDialog();
    }
  });
}
