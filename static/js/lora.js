/* LoRA：模型页卡片管理（加载/卸载/强度）+ 制作页入口摘要 */
import { $, state, toast, escapeHTML, escapeAttr, friendlyApiError } from "./core.js";
import { t } from "./i18n.js";
import { savedSettings } from "./settings.js";

const LORA_RANGE_MAX = 2;
const LORA_DEFAULT_WEIGHT = 0.4; // 与后端 pipeline.DEFAULT_LORA_WEIGHT 保持一致

export function renderLoras(loras) {
  state.loras = loras.map((l) => {
    const w = Number(savedSettings.loraWeights?.[l.id]);
    return { ...l, on: !!l.loaded, // 存档越界/缺失时回默认强度
      weight: Number.isFinite(w) ? Math.min(LORA_RANGE_MAX, Math.max(0, w)) : LORA_DEFAULT_WEIGHT,
      busy: false };
  });
  renderLoraCards();
}

/* 用 state.loras 现状渲染卡片（语言切换重渲染时权重/开关保持不动） */
function renderLoraCards() {
  const loras = state.loras;
  const grid = $("lora-grid");
  grid.innerHTML = "";
  $("lora-empty").classList.toggle("hidden", loras.length > 0);
  syncLoraSummary();

  loras.forEach((lora, i) => {
    const card = document.createElement("div");
    card.innerHTML = `
      <div class="flex items-center gap-2.5">
        <button type="button" data-toggle="${i}" role="switch" aria-checked="false"
          aria-label="${t("加载")} ${escapeAttr(lora.name)}"
          class="lora-toggle shrink-0 w-9 h-5 rounded-sm border border-border bg-panel-2 relative transition-colors">
          <span class="absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-[2px] bg-muted transition-[left]"></span>
        </button>
        <div class="min-w-0 flex-1">
          <div class="text-sm truncate" title="${escapeAttr(lora.name)}">${escapeHTML(lora.name)}</div>
          <div class="text-xs font-mono text-muted truncate">${escapeHTML(lora.filename)} · ${lora.size_mb} MB</div>
        </div>
        <div class="font-mono text-sm w-10 text-right text-muted" data-wval="${i}">${lora.weight.toFixed(2)}</div>
      </div>
      <input type="range" data-weight="${i}" min="0" max="${LORA_RANGE_MAX}" step="0.05" value="${lora.weight}"
        aria-label="${t("{s} 强度", { s: escapeAttr(lora.name) })}" class="w-full mt-3" disabled>`;
    card.querySelector(`[data-toggle="${i}"]`).addEventListener("click", () => toggleLora(i));
    card.querySelector(`[data-weight="${i}"]`).addEventListener("input", (e) => {
      state.loras[i].weight = Number(e.target.value);
      card.querySelector(`[data-wval="${i}"]`).textContent = state.loras[i].weight.toFixed(2);
      syncLoraSummary();
    });
    grid.appendChild(card);
    applyLoraUI(i);
  });
}

const loraCardClass = (on) =>
  `border rounded-md bg-panel p-3 transition-colors ${on
    ? "border-accent" : "border-border opacity-60"}`;

/* 把 state.loras[i] 的 on/busy 状态渲染到卡片 */
function applyLoraUI(i) {
  const lora = state.loras[i];
  const card = $("lora-grid").children[i];
  card.className = loraCardClass(lora.on);
  const btn = card.querySelector(`[data-toggle="${i}"]`);
  btn.setAttribute("aria-checked", String(lora.on));
  btn.disabled = lora.busy;
  btn.setAttribute("aria-label", `${t(lora.on ? "卸载" : "加载")} ${lora.name}`);
  btn.classList.toggle("border-accent", lora.on);
  btn.classList.toggle("bg-accent-dim", lora.on);
  btn.classList.toggle("opacity-50", lora.busy);
  const knob = btn.querySelector("span");
  knob.classList.toggle("left-0.5", !lora.on);
  knob.classList.toggle("left-[18px]", lora.on);
  knob.classList.toggle("bg-accent", lora.on);
  knob.classList.toggle("bg-muted", !lora.on);
  const slider = card.querySelector(`[data-weight="${i}"]`);
  slider.disabled = !lora.on;
  card.querySelector(`[data-wval="${i}"]`).classList.toggle("text-muted", !lora.on);
}

/* 开关 = 加载/卸载（后端常驻管理），失败时回滚 */
async function toggleLora(i) {
  const lora = state.loras[i];
  if (lora.busy) return;
  const target = !lora.on;
  lora.busy = true;
  applyLoraUI(i);
  try {
    const res = await fetch("/api/loras/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: lora.id, on: target }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(friendlyApiError({ ...err, status: res.status }));
    }
    lora.on = target;
    toast(target ? t("LoRA 已加载（常驻）") : t("LoRA 已卸载"));
  } catch (e) {
    toast(t("操作失败：{m}", { m: e.message }), true);
  } finally {
    lora.busy = false;
    applyLoraUI(i);
    syncLoraSummary();
  }
}

/* 制作页的 LoRA 入口按钮 + 模型页加载计数 */
export function syncLoraSummary() {
  const names = state.loras.filter((l) => l.on);
  const summary = $("lora-summary");
  summary.textContent = names.length ? t("LoRA · {n}", { n: names.length }) : t("选择 LoRA");
  summary.classList.toggle("is-on", names.length > 0);
  summary.title = names.length
    ? names.map((l) => `${l.name} ${l.weight.toFixed(2)}`).join(" · ")
    : t("在「模型」页管理加载与强度");
  $("lora-active-count").textContent = names.length ? t("{n} 个已加载", { n: names.length }) : "";
}

export const activeLoras = () =>
  state.loras.filter((l) => l.on)
    .map((l) => ({ id: l.id, weight: Math.round(l.weight * 100) / 100 }));

/* 语言切换后按现状重渲染 LoRA 卡片 */
document.addEventListener("langchange", renderLoraCards);
