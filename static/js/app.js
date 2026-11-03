/* Krea 2 Turbo 工作台前端 · 入口：装配各模块 + 启动初始化 */
import { $, state, toast, bindNav } from "./core.js";
import { savedSettings } from "./settings.js";
import { bindControls, renderPresets, renderExamples, renderMode } from "./studio.js";
import { bindPicker } from "./picker.js";
import { syncCommonBadge, bindCommonDialog } from "./common-words.js";
import { bindQueueUI } from "./queue.js";
import { bindModel, waitReady, renderPrecision, syncModelState } from "./model-page.js";
import { renderLoras } from "./lora.js";
import { loadGallery, bindGalleryScroll, bindLightbox } from "./gallery.js";

async function init() {
  bindControls();
  bindNav();
  bindModel();
  bindLightbox();
  bindPicker();
  bindCommonDialog();
  bindQueueUI();
  // 恢复上次的面板调整（风格/角色 id 在 renderPresets 里对列表校验后生效）
  $("prompt").value = savedSettings.prompt ?? "";
  state.selectedStyles = Array.isArray(savedSettings.selectedStyles)
    ? savedSettings.selectedStyles : [];
  state.selectedRole = savedSettings.role || null;
  state.commonWords = typeof savedSettings.commonWords === "string"
    ? savedSettings.commonWords : "";
  syncCommonBadge();
  state.aspect = savedSettings.aspect || "1:1";
  state.mode = savedSettings.mode === "i2i" ? "i2i" : "t2i";
  $("strength").value = savedSettings.strength ?? 0.6;
  $("strength-val").textContent = Number($("strength").value).toFixed(2);
  if (["bf16", "int8", "int4"].includes(savedSettings.precision)) {
    state.selectedPrecision = savedSettings.precision;
  }
  renderMode();
  // 点击 toast：复制文本并关闭（错误信息不再"闪太快没复制到"）
  $("toast").addEventListener("click", async () => {
    const el = $("toast");
    if (el.textContent) {
      try { await navigator.clipboard.writeText(el.textContent); } catch { /* 剪贴板不可用则仅关闭 */ }
    }
    el.classList.add("hidden");
  });
  renderExamples();
  bindGalleryScroll();
  try {
    const [presets, modelInfo] = await Promise.all([
      fetch("/api/presets").then((r) => r.json()),
      fetch("/api/model").then((r) => r.json()).catch(() => null),
    ]);
    renderPresets(presets);
    if (modelInfo) {
      renderPrecision(modelInfo.precision_hints);
      syncModelState(modelInfo);
    }
  } catch {
    toast("预设加载失败，请刷新页面", true);
  }
  loadGallery().catch(() => {});
  try {
    renderLoras(await fetch("/api/loras").then((r) => r.json()));
  } catch { /* loras 目录可能为空 */ }
  waitReady();
}

init();
