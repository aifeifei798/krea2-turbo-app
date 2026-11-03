/* 模型页：状态轮询、精度选择、加载/卸载；顶栏状态徽标与加载覆盖层 */
import { $, state, toast, friendlyApiError } from "./core.js";
import { saveSettings } from "./settings.js";
import { renderLoras } from "./lora.js";

/* ---------- 状态徽标 / 加载覆盖层 ---------- */

function setStatus(text, colorClass) {
  $("status-text").textContent = text;
  $("status-dot").className = `w-1.5 h-1.5 rounded-full ${colorClass}`;
}

export async function pollStatus() {
  try {
    const res = await fetch("/api/status");
    const st = await res.json();
    syncModelState(st);
    if (st.state === "ready") {
      setStatus("模型就绪", "bg-accent");
      $("loading-overlay").classList.add("hidden");
      $("loading-overlay").classList.remove("flex");
      $("generate-btn").disabled = false; // 队列化提交：模型就绪即可继续加任务
      // 精度切换后（新模型实例）LoRA 由后端重新全量加载，刷新一次同步开关与默认强度
      if (state.modelPrecision !== null && state.modelPrecision !== st.precision) {
        const loras = await fetch("/api/loras").then((r) => r.json()).catch(() => null);
        if (loras) renderLoras(loras);
      }
      state.modelPrecision = st.precision;
      return true;
    }
    if (st.state === "error") {
      setStatus("加载失败", "bg-danger");
      $("loading-overlay").classList.add("hidden");
      $("loading-overlay").classList.remove("flex");
      return true;
    }
    if (st.state === "unloaded") {
      // 手动卸载后不弹全屏遮罩，模型页有状态卡
      $("loading-overlay").classList.add("hidden");
      $("loading-overlay").classList.remove("flex");
      setStatus("未加载", "bg-muted");
      return true;
    }
    // loading：显示覆盖层 + 进度文案
    $("loading-overlay").classList.remove("hidden");
    $("loading-overlay").classList.add("flex");
    $("load-detail").textContent = st.detail || "加载中…";
    setStatus("加载中", "pulse-dot bg-muted");
    return false;
  } catch {
    setStatus("服务未连接", "bg-danger");
    syncModelState({ state: "error", detail: "服务未连接" });
    return false;
  }
}

export async function waitReady() {
  if (await pollStatus()) return;
  const timer = setInterval(async () => {
    if (await pollStatus()) clearInterval(timer);
  }, 1000);
}

/* 顶栏徽标 + 模型页状态卡同步 */
export function syncModelState(st) {
  state.modelReady = st.state === "ready";
  state.modelState = st.state;
  const dot = $("model-state-dot");
  const ready = st.state === "ready";
  const failed = st.state === "error";
  const loading = st.state === "loading";
  const unloaded = st.state === "unloaded";
  $("model-state-text").textContent =
    ready ? "就绪" : failed ? "失败" : loading ? "加载中" : "未加载";
  dot.className = `w-1.5 h-1.5 rounded-full ${ready ? "bg-accent" : failed ? "bg-danger" : loading ? "pulse-dot bg-muted" : "bg-muted"}`;
  $("model-state").classList.toggle("border-accent", ready);
  $("model-state").classList.toggle("text-accent", ready);
  $("model-detail").textContent = st.detail || "—";
  $("model-detail").classList.toggle("text-danger", failed);
  if (st.precision) state.modelPrecision = st.precision;
  syncLoadButtons(st.state);
}

/* 加载/卸载按钮态：加载在 未加载/失败/换精度 时可用；卸载在 就绪 时可用 */
function syncLoadButtons(modelState) {
  const loading = modelState === "loading";
  const ready = modelState === "ready";
  const samePrecision = state.selectedPrecision === state.modelPrecision;
  $("model-load-btn").disabled = loading || (ready && samePrecision);
  $("model-load-btn").textContent = ready && !samePrecision ? "切换并重载" : "加载模型";
  $("model-unload-btn").disabled = !ready || loading;
}

/* ---------- 精度选择 + 加载/卸载 ---------- */

export function renderPrecision(hints) {
  state.precisionHints = hints || {};
  const group = $("precision-group");
  group.innerHTML = "";
  [["bf16", "BF16 全精度"], ["int8", "INT8 8bit"], ["int4", "INT4 4bit"]].forEach(([id, label]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.dataset.id = id;
    b.setAttribute("aria-pressed", String(id === state.selectedPrecision));
    b.className = precisionClass(id === state.selectedPrecision);
    b.addEventListener("click", () => {
      state.selectedPrecision = id;
      group.querySelectorAll("button").forEach((x) => {
        const on = x.dataset.id === state.selectedPrecision;
        x.setAttribute("aria-pressed", String(on));
        x.className = precisionClass(on);
      });
      syncPrecisionHint();
      syncLoadButtons(state.modelState || "ready");
      saveSettings();
    });
    group.appendChild(b);
  });
  syncPrecisionHint();
}

const precisionClass = (on) =>
  `py-1.5 rounded-sm border font-mono text-xs transition-colors ${on
    ? "border-accent bg-accent-dim text-accent"
    : "border-border bg-panel-2 text-muted hover:border-accent hover:text-ink"}`;

function syncPrecisionHint() {
  $("precision-hint").textContent =
    state.precisionHints[state.selectedPrecision] || "—";
}

async function loadModel() {
  const btn = $("model-load-btn");
  btn.disabled = true;
  try {
    const res = await fetch("/api/model/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ precision: state.selectedPrecision }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(friendlyApiError({ ...err, status: res.status }));
    }
  } catch (e) {
    toast(`加载请求失败：${e.message}`, true);
    pollStatus();
    return;
  }
  // 等加载线程先把状态切成 loading，再进入轮询，避免误判"已就绪"
  await new Promise((r) => setTimeout(r, 500));
  waitReady();
}

async function unloadModel() {
  try {
    const res = await fetch("/api/model/unload", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    toast(`卸载失败：${e.message}`, true);
  }
  await pollStatus();
  // 卸载后 LoRA 全部回到未加载
  const loras = await fetch("/api/loras").then((r) => r.json()).catch(() => null);
  if (loras) renderLoras(loras);
  toast("模型已卸载");
}

export function bindModel() {
  $("model-load-btn").addEventListener("click", loadModel);
  $("model-unload-btn").addEventListener("click", unloadModel);
}
