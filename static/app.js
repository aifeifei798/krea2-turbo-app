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
  loras: [], // {id, name, filename, size_mb, on, weight}
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
      return true;
    }
    if (st.state === "error") {
      setStatus("加载失败", "bg-danger");
      $("loading-overlay").classList.add("hidden");
      $("loading-overlay").classList.remove("flex");
      toast(st.detail, true);
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

/* 模型页状态卡与顶栏徽标同步 */
function syncModelState(st) {
  const dot = $("model-state-dot");
  const ready = st.state === "ready";
  const failed = st.state === "error";
  $("model-state-text").textContent = ready ? "就绪" : failed ? "失败" : "加载中";
  dot.className = `w-1.5 h-1.5 rounded-full ${ready ? "bg-accent" : failed ? "bg-danger" : "pulse-dot bg-muted"}`;
  $("model-state").classList.toggle("border-accent", ready);
  $("model-state").classList.toggle("text-accent", ready);
  $("model-detail").textContent = st.detail || "—";
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
  state.loras = loras.map((l) => ({ ...l, on: false, weight: 1.0 }));
  const grid = $("lora-grid");
  grid.innerHTML = "";
  $("lora-empty").classList.toggle("hidden", loras.length > 0);
  $("lora-active-count").textContent = "";

  state.loras.forEach((lora, i) => {
    const card = document.createElement("div");
    card.className = loraCardClass(false);
    card.innerHTML = `
      <div class="flex items-center gap-2.5">
        <button type="button" data-toggle="${i}" role="switch" aria-checked="false"
          aria-label="启用 ${escapeAttr(lora.name)}"
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
  });
  syncLoraSummary();
}

const loraCardClass = (on) =>
  `border rounded-md bg-panel p-3 transition-colors ${on
    ? "border-accent" : "border-border opacity-60"}`;

function toggleLora(i) {
  const lora = state.loras[i];
  lora.on = !lora.on;
  const card = $("lora-grid").children[i];
  card.className = loraCardClass(lora.on);
  const btn = card.querySelector(`[data-toggle="${i}"]`);
  btn.setAttribute("aria-checked", String(lora.on));
  btn.classList.toggle("border-accent", lora.on);
  btn.classList.toggle("bg-accent-dim", lora.on);
  const knob = btn.querySelector("span");
  knob.classList.toggle("left-0.5", !lora.on);
  knob.classList.toggle("left-[18px]", lora.on);
  knob.classList.toggle("bg-accent", lora.on);
  knob.classList.toggle("bg-muted", !lora.on);
  const slider = card.querySelector(`[data-weight="${i}"]`);
  slider.disabled = !lora.on;
  card.querySelector(`[data-wval="${i}"]`).classList.toggle("text-muted", !lora.on);
  syncLoraSummary();
}

/* 制作页的 LoRA 摘要条 + 模型页启用计数 */
function syncLoraSummary() {
  const active = activeLoras();
  const names = state.loras.filter((l) => l.on);
  const summary = $("lora-summary");
  if (!names.length) {
    summary.textContent = "未启用";
    summary.classList.add("text-muted");
    summary.classList.remove("text-ink");
    $("lora-active-count").textContent = "";
  } else {
    summary.textContent = names.map((l) => `${l.name} ${l.weight.toFixed(2)}`).join(" · ");
    summary.classList.remove("text-muted");
    summary.classList.add("text-ink");
    $("lora-active-count").textContent = `${names.length} 个已启用`;
  }
}

const activeLoras = () =>
  state.loras.filter((l) => l.on)
    .map((l) => ({ id: l.id, weight: Math.round(l.weight * 100) / 100 }));

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
  btn.disabled = on || $("status-text").textContent !== "模型就绪";
  $("progress-wrap").classList.toggle("hidden", !on);
  if (on) {
    btn.innerHTML = '生成中 <span class="font-mono">…</span>';
    setProgress(0, 1, "排队中…");
  } else {
    btn.innerHTML = '生成 <span class="font-mono">▸</span>';
    state.currentTask = null;
  }
}

async function generate() {
  const prompt = $("prompt").value.trim();
  if (!prompt) { toast("请先输入提示词", true); return; }
  if (state.generating) return;

  const seedRaw = $("seed").value.trim();
  const body = {
    prompt,
    style: state.style,
    aspect: state.aspect,
    steps: Number($("steps").value),
    seed: seedRaw === "" ? null : Number(seedRaw),
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
      throw new Error(err.detail || `HTTP ${res.status}`);
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
    <figure class="group relative border border-border rounded-md overflow-hidden bg-panel cursor-pointer" data-id="${img.id}" tabindex="0" role="button" aria-label="查看 ${img.prompt ? "图片" : "未命名图片"}">
      <img src="${img.url}" alt="${escapeAttr(img.prompt || "生成的图片")}" loading="lazy" class="w-full h-auto block">
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
  bindLightbox();
  renderExamples();
  try {
    const [presets, loras] = await Promise.all([
      fetch("/api/presets").then((r) => r.json()),
      fetch("/api/loras").then((r) => r.json()).catch(() => []),
    ]);
    renderPresets(presets);
    renderLoras(loras);
  } catch {
    toast("预设加载失败，请刷新页面", true);
  }
  loadGallery().catch(() => {});
  waitReady();
}

init();
