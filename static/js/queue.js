/* 生成队列：提交、串行轮询进度、右上角队列弹层、取消（单条/全部）、当前进度条 */
import { $, state, toast, escapeHTML, escapeAttr, friendlyApiError, syncDataBlock } from "./core.js";
import { saveSettings } from "./settings.js";
import { insertCards } from "./gallery.js";
import { activeLoras } from "./lora.js";

/* 提交成功后登记任务并渲染队列行；轮询器在有活跃任务期间常开 */
function trackTask(taskId, snippet) {
  state.activeTasks[taskId] = { shown: 0, snippet };
  renderQueueRow(taskId);
  updateQueueBadge();
  if (!state.pollTimer) state.pollTimer = setInterval(pollActiveTasks, 500);
}

function updateQueueBadge() {
  const n = Object.keys(state.activeTasks).length;
  $("queue-count").textContent = String(n);
  $("queue-count").classList.toggle("hidden", n === 0);
}

function renderQueueRow(taskId) {
  const st = state.activeTasks[taskId];
  const row = document.createElement("div");
  row.dataset.task = taskId;
  row.className = "border border-border rounded-md bg-panel px-2.5 py-2";
  row.innerHTML = `
    <div class="flex items-center gap-2">
      <span data-dot class="w-1.5 h-1.5 rounded-full bg-accent pulse-dot shrink-0"></span>
      <span class="text-xs truncate flex-1" title="${escapeAttr(st.snippet)}">${escapeHTML(st.snippet)}</span>
      <button type="button" data-cancel="${taskId}" aria-label="取消此任务"
        class="shrink-0 w-6 h-6 rounded-sm border border-border text-muted hover:text-danger hover:border-danger transition-colors text-sm leading-none">×</button>
    </div>
    <div class="mt-1.5 h-0.5 bg-border rounded-full overflow-hidden">
      <div data-bar class="h-full w-full bg-accent origin-left scale-x-0 transition-transform duration-200"></div>
    </div>
    <div data-text class="mt-1 font-mono text-xs text-muted">排队中，模型就绪后自动开始</div>`;
  row.querySelector("[data-cancel]").addEventListener("click", () => cancelQueuedTask(taskId));
  $("queue-list").appendChild(row);
}

function updateQueueRow(taskId, text, pct, running) {
  const row = document.querySelector(`[data-task="${taskId}"]`);
  if (!row) return;
  row.dataset.running = running ? "1" : "0";
  row.querySelector("[data-text]").textContent = text;
  row.querySelector("[data-bar]").style.transform = `scaleX(${Math.max(0, Math.min(100, pct || 0)) / 100})`;
  const dot = row.querySelector("[data-dot]");
  dot.className = `w-1.5 h-1.5 rounded-full shrink-0 ${running ? "bg-accent pulse-dot" : "bg-muted"}`;
}

/* 单个任务收尾：摘行、停轮询、收起弹层；全部收尾时进度条转「完成 + 重跑」态 */
function finishTask(taskId) {
  delete state.activeTasks[taskId];
  document.querySelector(`[data-task="${taskId}"]`)?.remove();
  updateQueueBadge();
  if (!Object.keys(state.activeTasks).length) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    closeQueuePop();
    updateIdleProgress();
  }
}

/* 空闲态进度条：有成功过的任务 → 显示完成摘要 + 重跑按钮；否则隐藏 */
function updateIdleProgress() {
  const wrap = $("current-progress");
  const last = state.lastRequest;
  if (!last) {
    wrap.classList.add("hidden");
    $("cp-rerun").classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  $("cp-bar").style.transform = "scaleX(1)";
  $("cp-pct").textContent = "100%";
  const stylesText = (last.styles || []).map((s) => s.name).join(" · ");
  $("cp-text").textContent =
    `已完成：${(last.prompt || "").slice(0, 26)}${stylesText ? ` · ${stylesText}` : ""}`;
  wrap.setAttribute("aria-valuenow", "100");
  $("cp-rerun").classList.remove("hidden");
}

/* 轮询所有活跃任务：各自更新行内进度/上屏图片，终态收尾；并同步按钮下的当前进度条 */
async function pollActiveTasks() {
  const ids = Object.keys(state.activeTasks);
  let running = null; // {text, pct}
  let queued = 0;
  await Promise.all(ids.map(async (taskId) => {
    let task;
    try {
      const res = await fetch(`/api/tasks/${taskId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      task = await res.json();
    } catch (e) {
      toast(`进度查询失败：${e.message}`, true);
      finishTask(taskId);
      return;
    }
    if (task.state === "queued") {
      queued += 1;
      updateQueueRow(taskId, "排队中，模型就绪后自动开始", 0, false);
      return;
    }
    if (task.state === "running") {
      const total = task.total_steps || 1;
      const roundText = (task.rounds || 1) > 1 ? `第 ${task.round}/${task.rounds} 轮 · ` : "";
      const canceled = task.cancel ? "停止中 · " : "";
      const text = `${canceled}${roundText}扩散中 ${task.step}/${total}`;
      running = { text, pct: (task.step / total) * 100 };
      updateQueueRow(taskId, text, running.pct, true);
      showTaskImages(task);
      return;
    }
    showTaskImages(task); // 失败/取消前已出的图也保留
    if (task.state === "error") {
      toast(`生成失败：${task.error}`, true);
    } else {
      state.lastRequest = task.request; // 成功（含取消保留部分）即可重跑
      if (task.canceled) toast(`已停止，保留了 ${task.images.length} 张已完成的图`);
    }
    finishTask(taskId);
  }));
  updateCurrentProgress(running, queued);
}

/* 生成按钮下的当前进度：有运行中的显示实时进度，全在排队则显示队列数 */
function updateCurrentProgress(running, queued) {
  const wrap = $("current-progress");
  if (!running && !queued) {
    updateIdleProgress();
    return;
  }
  wrap.classList.remove("hidden");
  $("cp-rerun").classList.add("hidden");
  const pct = running ? Math.max(0, Math.min(100, running.pct)) : 0;
  $("cp-bar").style.transform = `scaleX(${pct / 100})`;
  $("cp-pct").textContent = `${Math.round(pct)}%`;
  $("cp-text").textContent = running ? running.text : `队列中 ${queued} 个任务等待处理`;
  wrap.setAttribute("aria-valuenow", String(Math.round(pct)));
}

/* 队列行取消：还在排队的立即摘行（反正不会出图）；运行中的走后端 interrupt，
   当前轮丢弃、已完成轮保留，轮询到终态再摘行 */
async function cancelQueuedTask(taskId) {
  const row = document.querySelector(`[data-task="${taskId}"]`);
  const isRunning = row?.dataset.running === "1";
  try {
    const res = await fetch(`/api/tasks/${taskId}/cancel`, { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (isRunning) {
      updateQueueRow(taskId, "停止中…", null, false);
    } else {
      finishTask(taskId);
      toast("已取消排队任务");
    }
  } catch (e) {
    toast(`停止失败：${e.message}`, true);
  }
}

/* 全部取消：排队的立即摘行，运行中的逐个 interrupt */
async function cancelAllQueued() {
  const ids = Object.keys(state.activeTasks);
  if (!ids.length) return;
  await Promise.allSettled(
    ids.map((id) => fetch(`/api/tasks/${id}/cancel`, { method: "POST" })));
  ids.forEach((id) => {
    const row = document.querySelector(`[data-task="${id}"]`);
    if (row?.dataset.running === "1") updateQueueRow(id, "停止中…", null, false);
    else finishTask(id);
  });
  toast("已请求取消全部任务");
}

function closeQueuePop() {
  $("queue-pop").classList.add("hidden");
  $("queue-btn").setAttribute("aria-expanded", "false");
}

/* 把 task.images 里尚未进画廊的部分插进去（次数模式每轮出图即上屏） */
function showTaskImages(task) {
  const st = state.activeTasks[task.task_id];
  if (!st) return;
  const fresh = (task.images || []).slice(st.shown);
  if (!fresh.length) return;
  st.shown = task.images.length;
  state.images.unshift(...fresh);
  state.galleryTotal += fresh.length;
  insertCards(fresh);
  $("gallery-count").textContent = String(state.galleryTotal);
}

const SEED_MAX = 9007199254740991; // Number.MAX_SAFE_INTEGER，torch 上限之内

export async function generate() {
  const prompt = $("prompt").value.trim();
  // 通用词会拼在提示词最前，填写了通用词即视为有内容
  if (!prompt && !(state.commonWords || "").trim()) {
    toast("请先输入提示词或通用词", true);
    return;
  }
  if (prompt.length > 4000) { toast("提示词超过 4000 字，请精简", true); return; }
  if (state.mode === "i2i" && !state.initImage) { toast("图生图模式请先上传参考图", true); return; }

  const seedRaw = $("seed").value.trim();
  let seed = null;
  if (seedRaw !== "") {
    seed = Math.min(Math.max(Math.floor(Number(seedRaw)) || 0, 0), SEED_MAX);
    if (String(seed) !== seedRaw.replace(/^0+(?=\d)/, "")) {
      $("seed").value = seed; // 超限/非法输入自动收敛回填
      syncDataBlock();
      saveSettings();
      toast("种子已收敛到有效范围", true);
    }
  }
  const body = {
    prompt,
    styles: state.selectedStyles,
    role: state.selectedRole,
    common: state.commonWords,
    aspect: state.aspect,
    steps: Number($("steps").value),
    seed,
    batch: Number($("batch").value),
    rounds: Number($("rounds").value),
    ...(state.mode === "i2i" && state.initImage
      ? { init_image: state.initImage, strength: Number($("strength").value) }
      : {}),
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

  trackTask(data.task_id, prompt.slice(0, 40));
}

/* 一键重跑：沿用上次成功任务的全部参数，种子换随机 */
async function rerunLast() {
  const last = state.lastRequest;
  if (!last) return;
  const body = {
    prompt: last.prompt,
    styles: (last.styles || []).map((s) => s.id),
    role: last.role ? last.role.id : null,
    common: last.common || "",
    aspect: last.aspect_id || "1:1",
    steps: last.steps || 8,
    seed: null, // 重跑：换随机种子
    batch: last.batch || 1,
    rounds: last.rounds || 1,
    // 参考图不落盘，重绘任务沿用面板当前参考图
    ...(last.img2img && state.initImage
      ? { init_image: state.initImage, strength: last.strength ?? 0.6 }
      : {}),
    loras: activeLoras(),
  };
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
    const data = await res.json();
    trackTask(data.task_id, (last.prompt || "").slice(0, 40));
    toast("已重新提交（新随机种子）");
  } catch (e) {
    toast(`重跑失败：${e.message}`, true);
  }
}

export function bindQueueUI() {
  $("generate-btn").addEventListener("click", generate);
  $("cp-rerun").addEventListener("click", rerunLast);
  // 队列弹层：按钮开合、关闭按钮、点外部收起、全部取消
  $("queue-btn").addEventListener("click", () => {
    const pop = $("queue-pop");
    const nowOpen = pop.classList.contains("hidden");
    pop.classList.toggle("hidden", !nowOpen);
    $("queue-btn").setAttribute("aria-expanded", String(nowOpen));
  });
  $("queue-close").addEventListener("click", closeQueuePop);
  $("queue-cancel-all").addEventListener("click", cancelAllQueued);
  document.addEventListener("click", (e) => {
    if ($("queue-pop").classList.contains("hidden")) return;
    if (e.target.closest("#queue-pop") || e.target.closest("#queue-btn")) return;
    closeQueuePop();
  });
  // 提示词里 Ctrl/Cmd+Enter 直接提交
  $("prompt").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); generate(); }
  });
}
