/* 通用词：放在每次生成提示词最前的画质/质量词，弹窗编辑 + 快捷词 */
import { $, state, toast } from "./core.js";
import { t } from "./i18n.js";
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
  const plus = '<svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
  btn.innerHTML = plus + `<span>${on ? t("通用词 {n}", { n }) : t("通用词")}</span>`;
  btn.classList.toggle("text-accent", on);
  btn.classList.toggle("border-accent", on);
}

function openCommonDialog() {
  $("common-text").value = state.commonWords;
  renderCommonChips();
  updateCommonInfo();
  syncCommonHistory();
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
    b.title = t("点击追加");
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
  $("common-info").textContent = n ? t("{n} 个词，将放在提示词最前", { n }) : t("未填写");
}

/* 上一版通用词：与当前生效值相同时没什么可写回的，直接藏起来 */
function syncCommonHistory() {
  const prev = (state.commonWordsPrev || "").trim();
  const show = !!prev && prev !== (state.commonWords || "").trim();
  $("common-history").classList.toggle("hidden", !show);
  $("common-history").classList.toggle("flex", show);
  if (show) $("common-history-text").textContent = prev;
}

function saveCommonWords() {
  const v = $("common-text").value.trim().replace(/[,;\s]+$/, "");
  // 记住被替换掉的那一版（只在确实变了且非空时留存），供弹窗里一键写回
  if (v !== state.commonWords && state.commonWords.trim()) {
    state.commonWordsPrev = state.commonWords;
  }
  state.commonWords = v;
  saveSettings();
  syncCommonBadge();
  closeCommonDialog();
  toast(v ? t("通用词已保存，将放在提示词最前") : t("通用词已清空"));
}

export function bindCommonDialog() {
  $("common-btn").addEventListener("click", openCommonDialog);
  $("common-close").addEventListener("click", closeCommonDialog);
  $("common-dialog").querySelector("[data-close]").addEventListener("click", closeCommonDialog);
  $("common-save").addEventListener("click", saveCommonWords);
  // 清空 = 清掉输入框并直接保存（走同一条保存路径：记历史、更新徽标、关窗、提示）
  $("common-clear").addEventListener("click", () => {
    $("common-text").value = "";
    saveCommonWords();
  });
  $("common-restore").addEventListener("click", () => {
    // 写回输入框（不直接生效），方便先看一眼或接着改，再点保存
    $("common-text").value = state.commonWordsPrev;
    updateCommonInfo();
    $("common-text").focus();
    toast(t("已写回上次的通用词，点保存生效"));
  });
  $("common-text").addEventListener("input", updateCommonInfo);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("common-dialog").classList.contains("hidden")) {
      closeCommonDialog();
    }
  });
}

/* 语言切换后重渲染入口按钮 */
document.addEventListener("langchange", syncCommonBadge);
