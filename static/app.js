/* Krea 2 Turbo 工作台前端：状态轮询 + 画廊 + 灯箱 */
"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  styles: [],
  aspects: [],
  maxSteps: 16,
  defaultSteps: 8,
  style: "none",
  aspect: "1:1",
  batch: 1,
  loras: [], // {id, name, filename, size_mb, on(=已加载), weight}
  selectedPrecision: "bf16",
  precisionHints: {},
  modelReady: false,
  modelState: null,
  modelPrecision: null,
  generating: false,
  currentTask: null,
  pollTimer: null,
  images: [],
};

/* ---------- 基础 UI ---------- */

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("border-danger", isError);
  el.classList.toggle("text-danger", isError);
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
}

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------- 状态徽标 / 加载覆盖层 ---------- */

function setStatus(text, colorClass) {
  $("status-text").textContent = text;
  $("status-dot").className = `w-1.5 h-1.5 rounded-full ${colorClass}`;
}

async function pollStatus() {
  try {
    const res = await fetch("/api/status");
    const st = await res.json();
    syncModelState(st);
    if (st.state === "ready") {
      setStatus("模型就绪", "bg-accent");
      $("loading-overlay").classList.add("hidden");
      $("loading-overlay").classList.remove("flex");
      $("generate-btn").disabled = state.generating;
      // 精度切换后（新模型实例）LoRA 全部回到未加载，刷新一次
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

/* 顶栏徽标 + 模型页状态卡同步 */
function syncModelState(st) {
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

/* ---------- 模型页：精度选择 + 加载/卸载 ---------- */

function renderPrecision(hints) {
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

function bindModel() {
  $("model-load-btn").addEventListener("click", loadModel);
  $("model-unload-btn").addEventListener("click", unloadModel);
}

/* ---------- 视图切换 ---------- */

function switchView(view) {
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

function bindNav() {
  document.querySelectorAll("[data-view]").forEach((btn) =>
    btn.addEventListener("click", () => switchView(btn.dataset.view)));
  $("goto-models").addEventListener("click", () => switchView("models"));
  $("lora-summary").addEventListener("click", () => switchView("models"));
}

async function waitReady() {
  if (await pollStatus()) return;
  const timer = setInterval(async () => {
    if (await pollStatus()) clearInterval(timer);
  }, 1000);
}

/* ---------- 控制面板 ---------- */

function renderPresets(data) {
  state.styles = data.styles;
  state.aspects = data.aspects;
  state.maxSteps = data.max_steps;
  state.defaultSteps = data.default_steps;
  $("steps").value = state.defaultSteps;

  const chips = $("style-chips");
  chips.innerHTML = "";
  state.styles.forEach((s) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = s.name;
    b.dataset.id = s.id;
    b.setAttribute("aria-pressed", String(s.id === state.style));
    b.className = chipClass(s.id === state.style);
    b.addEventListener("click", () => {
      state.style = s.id;
      chips.querySelectorAll("button").forEach((x) => {
        const on = x.dataset.id === state.style;
        x.setAttribute("aria-pressed", String(on));
        x.className = chipClass(on);
      });
    });
    chips.appendChild(b);
  });

  const aspects = $("aspect-group");
  aspects.innerHTML = "";
  state.aspects.forEach((a) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = a.id;
    b.dataset.id = a.id;
    b.title = a.name;
    b.setAttribute("aria-pressed", String(a.id === state.aspect));
    b.className = aspectClass(a.id === state.aspect);
    b.addEventListener("click", () => {
      state.aspect = a.id;
      aspects.querySelectorAll("button").forEach((x) => {
        const on = x.dataset.id === state.aspect;
        x.setAttribute("aria-pressed", String(on));
        x.className = aspectClass(on);
      });
      syncDataBlock();
    });
    aspects.appendChild(b);
  });

  const batches = $("batch-group");
  batches.innerHTML = "";
  [1, 2, 3, 4].forEach((n) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = n;
    b.dataset.id = n;
    b.setAttribute("aria-pressed", String(n === state.batch));
    b.className = aspectClass(n === state.batch);
    b.addEventListener("click", () => {
      state.batch = n;
      batches.querySelectorAll("button").forEach((x) => {
        const on = Number(x.dataset.id) === state.batch;
        x.setAttribute("aria-pressed", String(on));
        x.className = aspectClass(on);
      });
    });
    batches.appendChild(b);
  });

  syncDataBlock();
}

const chipClass = (on) =>
  `px-2.5 py-1 rounded-sm border text-xs transition-colors ${on
    ? "border-accent bg-accent-dim text-accent"
    : "border-border bg-panel text-muted hover:border-accent hover:text-ink"}`;

const aspectClass = (on) =>
  `py-1.5 rounded-sm border font-mono text-xs transition-colors ${on
    ? "border-accent bg-accent-dim text-accent"
    : "border-border bg-panel text-muted hover:border-accent hover:text-ink"}`;

function currentAspect() {
  return state.aspects.find((a) => a.id === state.aspect) || { width: 1024, height: 1024 };
}

function syncDataBlock() {
  const a = currentAspect();
  $("data-steps").textContent = $("steps").value;
  $("data-size").textContent = a.width === a.height ? `${a.width}²` : `${a.width}×${a.height}`;
  const seedVal = $("seed").value.trim();
  $("data-seed").textContent = seedVal === "" ? "auto" : seedVal;
}

function bindControls() {
  $("steps").addEventListener("input", syncDataBlock);
  $("seed").addEventListener("input", syncDataBlock);
  $("seed-random").addEventListener("click", () => {
    $("seed").value = Math.floor(Math.random() * 2147483647);
    syncDataBlock();
  });
  $("seed-clear").addEventListener("click", () => {
    $("seed").value = "";
    syncDataBlock();
  });
  $("generate-btn").addEventListener("click", generate);
  $("refresh-btn").addEventListener("click", () => loadGallery().catch(() => toast("刷新失败", true)));
}

/* ---------- LoRA（管理界面在「模型」页） ---------- */

const LORA_RANGE_MAX = 2;

function renderLoras(loras) {
  state.loras = loras.map((l) => ({ ...l, on: !!l.loaded, weight: 1.0, busy: false }));
  const grid = $("lora-grid");
  grid.innerHTML = "";
  $("lora-empty").classList.toggle("hidden", loras.length > 0);
  syncLoraSummary();

  state.loras.forEach((lora, i) => {
    const card = document.createElement("div");
    card.innerHTML = `
      <div class="flex items-center gap-2.5">
        <button type="button" data-toggle="${i}" role="switch" aria-checked="false"
          aria-label="加载 ${escapeAttr(lora.name)}"
          class="lora-toggle shrink-0 w-9 h-5 rounded-sm border border-border bg-panel-2 relative transition-colors">
          <span class="absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-[2px] bg-muted transition-[left]"></span>
        </button>
        <div class="min-w-0 flex-1">
          <div class="text-sm truncate" title="${escapeAttr(lora.name)}">${escapeHTML(lora.name)}</div>
          <div class="text-xs font-mono text-muted truncate">${escapeHTML(lora.filename)} · ${lora.size_mb} MB</div>
        </div>
        <div class="font-mono text-sm w-10 text-right text-muted" data-wval="${i}">1.00</div>
      </div>
      <input type="range" data-weight="${i}" min="0" max="${LORA_RANGE_MAX}" step="0.05" value="1.0"
        aria-label="${escapeAttr(lora.name)} 强度" class="w-full mt-3" disabled>`;
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
  btn.setAttribute("aria-label", `${lora.on ? "卸载" : "加载"} ${lora.name}`);
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
    toast(target ? "LoRA 已加载（常驻）" : "LoRA 已卸载");
  } catch (e) {
    toast(`操作失败：${e.message}`, true);
  } finally {
    lora.busy = false;
    applyLoraUI(i);
    syncLoraSummary();
  }
}

/* 制作页的 LoRA 摘要条 + 模型页加载计数 */
function syncLoraSummary() {
  const active = activeLoras();
  const names = state.loras.filter((l) => l.on);
  const summary = $("lora-summary");
  if (!names.length) {
    summary.textContent = "未加载";
    summary.classList.add("text-muted");
    summary.classList.remove("text-ink");
    $("lora-active-count").textContent = "";
  } else {
    summary.textContent = names.map((l) => `${l.name} ${l.weight.toFixed(2)}`).join(" · ");
    summary.classList.remove("text-muted");
    summary.classList.add("text-ink");
    $("lora-active-count").textContent = `${names.length} 个已加载`;
  }
}

const activeLoras = () =>
  state.loras.filter((l) => l.on)
    .map((l) => ({ id: l.id, weight: Math.round(l.weight * 100) / 100 }));

/* FastAPI 校验错误（422 detail 数组）转可读中文 */
const FIELD_NAMES = {
  prompt: "提示词", style: "风格", aspect: "比例", steps: "步数",
  seed: "种子", batch: "批量", loras: "LoRA", weight: "强度",
};

function friendlyApiError(err) {
  if (Array.isArray(err?.detail)) {
    return err.detail.map((d) => {
      const field = FIELD_NAMES[d.loc?.[1]] || d.loc?.[1] || "参数";
      const ctx = d.ctx || {};
      const rule = {
        less_than_equal: `不能超过 ${ctx.le}`,
        greater_than_equal: `不能小于 ${ctx.ge}`,
        string_too_long: `超过 ${ctx.max_length} 字`,
        string_too_short: `至少 ${ctx.min_length} 字`,
        missing: "缺少该参数",
        int_parsing: "需要是数字",
      }[d.type] || d.msg || "格式不正确";
      return `${field}${rule}`;
    }).join("；");
  }
  if (typeof err?.detail === "string") return err.detail;
  return `HTTP ${err?.status || ""}`.trim() || "未知错误";
}

/* ---------- 生成流程 ---------- */

function setProgress(step, total, text) {
  const pct = total > 0 ? Math.round((step / total) * 100) : 0;
  $("progress-bar").style.transform = `scaleX(${pct / 100})`;
  $("progress-pct").textContent = `${pct}%`;
  $("progress-text").textContent = text;
  $("progress-wrap").setAttribute("aria-valuenow", String(pct));
}

function setGenerating(on) {
  state.generating = on;
  const btn = $("generate-btn");
  btn.disabled = on || !state.modelReady;
  $("progress-wrap").classList.toggle("hidden", !on);
  if (on) {
    btn.innerHTML = '生成中 <span class="font-mono">…</span>';
    setProgress(0, 1, "排队中…");
  } else {
    btn.innerHTML = '生成 <span class="font-mono">▸</span>';
    state.currentTask = null;
  }
}

const SEED_MAX = 9007199254740991; // Number.MAX_SAFE_INTEGER，torch 上限之内

async function generate() {
  const prompt = $("prompt").value.trim();
  if (!prompt) { toast("请先输入提示词", true); return; }
  if (prompt.length > 4000) { toast("提示词超过 4000 字，请精简", true); return; }
  if (state.generating) return;

  const seedRaw = $("seed").value.trim();
  let seed = null;
  if (seedRaw !== "") {
    seed = Math.min(Math.max(Math.floor(Number(seedRaw)) || 0, 0), SEED_MAX);
    if (String(seed) !== seedRaw.replace(/^0+(?=\d)/, "")) {
      $("seed").value = seed; // 超限/非法输入自动收敛回填
      syncDataBlock();
      toast("种子已收敛到有效范围", true);
    }
  }
  const body = {
    prompt,
    style: state.style,
    aspect: state.aspect,
    steps: Number($("steps").value),
    seed,
    batch: state.batch,
    loras: activeLoras(),
  };

  let data;
  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(friendlyApiError({ ...err, status: res.status }));
    }
    data = await res.json();
  } catch (e) {
    toast(`提交失败：${e.message}`, true);
    return;
  }

  state.currentTask = data.task_id;
  setGenerating(true);
  pollTask(data.task_id);
}

function pollTask(taskId) {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    let task;
    try {
      const res = await fetch(`/api/tasks/${taskId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      task = await res.json();
    } catch (e) {
      clearInterval(state.pollTimer);
      toast(`进度查询失败：${e.message}`, true);
      setGenerating(false);
      return;
    }
    if (task.state === "queued") return;
    if (task.state === "running") {
      const total = task.total_steps || 1;
      setProgress(task.step, total, `扩散中 ${task.step}/${total}`);
      return;
    }
    clearInterval(state.pollTimer);
    if (task.state === "error") {
      toast(`生成失败：${task.error}`, true);
      setGenerating(false);
      return;
    }
    setProgress(task.total_steps, task.total_steps, "完成");
    state.images.unshift(...task.images);
    insertCards(task.images);
    $("gallery-count").textContent = String(state.images.length);
    setTimeout(() => setGenerating(false), 400);
  }, 500);
}

/* ---------- 画廊 ---------- */

function cardHTML(img) {
  const seedText = img.seed === null || img.seed === undefined ? "auto" : String(img.seed);
  return `
    <figure class="group relative border border-border rounded-md overflow-hidden bg-panel cursor-pointer" data-id="${img.id}" tabindex="0" role="button" aria-label="查看：${escapeAttr((img.prompt || "未命名图片").slice(0, 40))}">
      <div class="w-full aspect-[4/3] bg-panel-2 flex items-center justify-center overflow-hidden">
        <img src="${img.url}" alt="${escapeAttr(img.prompt || "生成的图片")}" loading="lazy" class="max-w-full max-h-full w-auto h-auto object-contain">
      </div>
      <figcaption class="absolute inset-x-0 bottom-0 hidden group-hover:block group-focus-within:block bg-paper/85 px-3 py-2">
        <div class="flex items-center gap-2 font-mono text-xs text-muted">
          <span class="text-ink truncate">${escapeHTML(img.style_name || "自由发挥")}</span>
          <span class="shrink-0">${img.width}×${img.height}</span>
          <span class="shrink-0">seed ${seedText}</span>
        </div>
      </figcaption>
      <button type="button" data-del="${img.id}" aria-label="删除这张图片"
        class="absolute top-2 right-2 hidden group-hover:flex group-focus-within:flex w-7 h-7 items-center justify-center rounded-sm border border-border bg-paper text-muted hover:text-danger hover:border-danger transition-colors text-sm">×</button>
    </figure>`;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const escapeAttr = escapeHTML;

function insertCards(images) {
  if (!images.length) return;
  $("empty-state").classList.add("hidden");
  const gallery = $("gallery");
  const frag = document.createElement("template");
  frag.innerHTML = images.map(cardHTML).join("");
  frag.content.querySelectorAll("figure").forEach(bindCard);
  gallery.prepend(frag.content);
}

function bindCard(fig) {
  const open = () => openLightbox(fig.dataset.id);
  fig.addEventListener("click", open);
  fig.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
  });
  fig.querySelector("[data-del]").addEventListener("click", (e) => {
    e.stopPropagation();
    deleteImage(e.currentTarget.dataset.del);
  });
}

async function loadGallery() {
  const res = await fetch("/api/images");
  state.images = await res.json();
  const gallery = $("gallery");
  gallery.innerHTML = "";
  $("gallery-count").textContent = String(state.images.length);
  if (!state.images.length) {
    $("empty-state").classList.remove("hidden");
    return;
  }
  $("empty-state").classList.add("hidden");
  const frag = document.createElement("template");
  frag.innerHTML = state.images.map(cardHTML).join("");
  frag.content.querySelectorAll("figure").forEach(bindCard);
  gallery.appendChild(frag.content);
}

async function deleteImage(id) {
  try {
    const res = await fetch(`/api/images/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    toast(`删除失败：${e.message}`, true);
    return;
  }
  state.images = state.images.filter((i) => i.id !== id);
  $("gallery-count").textContent = String(state.images.length);
  document.querySelector(`figure[data-id="${CSS.escape(id)}"]`)?.remove();
  if (!state.images.length) $("empty-state").classList.remove("hidden");
  if (lightboxId === id) closeLightbox();
  toast("已删除");
}

/* ---------- 示例提示词（来自 Krea 2 官方示例的风格方向） ---------- */

const EXAMPLES = [
  "雨后深夜的小巷，霓虹灯牌倒映在积水路面，电影感",
  "一只柴犬坐在铺满银杏叶的台阶上，秋日午后暖光，写实摄影",
  "漂浮在云海之上的悬浮岛屿，水彩风格，柔和晨光",
];

function renderExamples() {
  const box = $("example-prompts");
  EXAMPLES.forEach((p) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = p;
    b.className = "px-3 py-2 rounded-sm border border-border bg-panel text-left text-xs text-muted hover:border-accent hover:text-ink transition-colors";
    b.addEventListener("click", () => {
      $("prompt").value = p;
      $("prompt").focus();
    });
    box.appendChild(b);
  });
}

/* ---------- 灯箱 ---------- */

let lightboxId = null;
let deleteArmed = false;
let deleteTimer = null;

function openLightbox(id) {
  const img = state.images.find((i) => i.id === id);
  if (!img) return;
  lightboxId = id;
  disarmDelete();
  $("lb-img").src = img.url;
  $("lb-img").alt = img.prompt || "生成的图片";
  $("lb-prompt").textContent = img.prompt || "（提示词缺失）";
  const seedText = img.seed === null || img.seed === undefined ? "auto" : String(img.seed);
  const loraText = (img.loras || []).map((l) => `${l.name} ${l.weight.toFixed(2)}`).join(" · ");
  $("lb-meta").innerHTML = [
    ["风格", img.style_name || "—"],
    ["尺寸", img.width ? `${img.width}×${img.height}` : "—"],
    ["步数", img.steps || "—"],
    ["种子", seedText],
    ...(loraText ? [["LoRA", loraText]] : []),
    ["时间", img.created_at ? fmtTime(img.created_at) : "—"],
    ["模型", img.model || "Krea 2 Turbo"],
  ].map(([k, v]) => `<div class="flex gap-2"><dt class="shrink-0">${k}</dt><dd class="text-ink truncate" title="${escapeAttr(v)}">${escapeHTML(v)}</dd></div>`).join("");
  $("lb-download").href = img.url;
  $("lb-download").setAttribute("download", `${id}.jpg`);
  $("lightbox").classList.remove("hidden");
  $("lb-close").focus();
}

function closeLightbox() {
  lightboxId = null;
  disarmDelete();
  $("lightbox").classList.add("hidden");
  $("lb-img").src = "";
}

function disarmDelete() {
  deleteArmed = false;
  clearTimeout(deleteTimer);
  const btn = $("lb-delete");
  btn.textContent = "删除";
  btn.classList.remove("text-danger", "border-danger");
}

function bindLightbox() {
  $("lb-close").addEventListener("click", closeLightbox);
  $("lightbox").querySelector("[data-close]").addEventListener("click", closeLightbox);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("lightbox").classList.contains("hidden")) closeLightbox();
  });
  $("lb-copy").addEventListener("click", async () => {
    const img = state.images.find((i) => i.id === lightboxId);
    if (!img?.prompt) return;
    try {
      await navigator.clipboard.writeText(img.prompt);
      toast("提示词已复制");
    } catch {
      toast("复制失败（浏览器未授权剪贴板）", true);
    }
  });
  $("lb-delete").addEventListener("click", () => {
    if (!deleteArmed) {
      deleteArmed = true;
      const btn = $("lb-delete");
      btn.textContent = "确认删除？";
      btn.classList.add("text-danger", "border-danger");
      deleteTimer = setTimeout(disarmDelete, 3000);
      return;
    }
    if (lightboxId) deleteImage(lightboxId);
  });
}

/* ---------- 启动 ---------- */

async function init() {
  bindControls();
  bindNav();
  bindModel();
  bindLightbox();
  renderExamples();
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
