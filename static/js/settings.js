/* 设置记忆（localStorage：保留最后一次的面板调整） */
import { $, state } from "./core.js";

export const SETTINGS_KEY = "krea2-panel-v1";

export function readSettings() {
  try {
    const v = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export const savedSettings = readSettings(); // 启动时读一次存档

/* 把当前面板状态写入存档；localStorage 不可用（隐私模式等）静默跳过 */
export function saveSettings() {
  const data = {
    prompt: $("prompt").value,
    selectedStyles: state.selectedStyles,
    role: state.selectedRole,
    commonWords: state.commonWords,
    aspect: state.aspect,
    mode: state.mode,
    strength: Number($("strength").value),
    inpaintStrength: Number($("inpaint-strength").value),
    inpaintBrush: Number($("inpaint-brush").value),
    steps: Number($("steps").value),
    batch: Number($("batch").value),
    rounds: Number($("rounds").value),
    seed: $("seed").value,
    precision: state.selectedPrecision,
    // 与旧存档按 id 合并：LoRA 列表尚未渲染时不清掉已有强度
    loraWeights: {
      ...savedSettings.loraWeights,
      ...Object.fromEntries(state.loras.map((l) => [l.id, l.weight])),
    },
  };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
    savedSettings.loraWeights = data.loraWeights;
  } catch { /* 存不进就算了，不影响使用 */ }
}
