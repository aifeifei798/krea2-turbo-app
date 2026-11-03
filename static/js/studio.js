/* 制作面板：预设渲染、比例/步数/批量/次数/种子绑定、模式切换与图生图参考图 */
import { $, state, toast, aspectClass, syncDataBlock } from "./core.js";
import { savedSettings, saveSettings } from "./settings.js";
import { syncStyleSummary } from "./picker.js";
import { generate } from "./queue.js";
import { loadGallery } from "./gallery.js";

export function renderPresets(data) {
  state.styles = data.styles;
  state.roles = data.roles || [];
  state.aspects = data.aspects;
  state.maxSteps = data.max_steps;
  state.defaultSteps = data.default_steps;
  // 恢复上次的调整（存档里的 id 已失效则丢弃）
  state.selectedStyles = state.selectedStyles.filter(
    (id) => state.styles.some((s) => s.id === id));
  if (state.selectedRole && !state.roles.some((r) => r.id === state.selectedRole)) {
    state.selectedRole = null;
  }
  if (!state.aspects.some((a) => a.id === state.aspect)) state.aspect = "1:1";
  $("steps").value = savedSettings.steps ?? state.defaultSteps;
  const setSelect = (id, v) => {
    if ([...$(id).options].some((o) => o.value === String(v))) $(id).value = v;
  };
  setSelect("batch", savedSettings.batch);
  setSelect("rounds", savedSettings.rounds);
  if (typeof savedSettings.seed === "string") $("seed").value = savedSettings.seed;
  syncStyleSummary();

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
      saveSettings();
    });
    aspects.appendChild(b);
  });

  /* 批量 / 次数用原生下拉（见 index.html），提交时直接读 select 值 */

  syncDataBlock();
}

export function bindControls() {
  $("steps").addEventListener("input", syncDataBlock);
  $("seed").addEventListener("input", syncDataBlock);
  // 滑杆/输入框/下拉的任何调整立即入档（按钮类在各自 handler 里存）
  document.addEventListener("input", saveSettings);
  document.addEventListener("change", saveSettings);
  // 图生图：参考图上传/拖入/移除 + 幅度读数
  $("strength").addEventListener("input", () => {
    $("strength-val").textContent = Number($("strength").value).toFixed(2);
  });
  $("i2i-drop").addEventListener("click", () => $("i2i-file").click());
  $("i2i-drop").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("i2i-file").click(); }
  });
  $("i2i-file").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) readInitImage(file);
    e.target.value = ""; // 允许重复选择同一文件
  });
  $("i2i-drop").addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  $("i2i-drop").addEventListener("drop", (e) => {
    e.preventDefault();
    const file = [...(e.dataTransfer.files || [])].find((f) => f.type.startsWith("image/"));
    if (file) readInitImage(file);
    else toast("请拖入图片文件", true);
  });
  $("i2i-remove").addEventListener("click", (e) => {
    e.stopPropagation();
    setInitImage(null);
  });
  // 整页拖拽兜底：图片拖到上传框外也不让浏览器跳转打开原图，而是照常上传
  document.addEventListener("dragover", (e) => {
    if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    if (e.target.closest?.("#i2i-drop")) return; // 上传框自己的 handler 已处理
    e.preventDefault();
    const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith("image/"));
    if (file) {
      switchMode("i2i");
      readInitImage(file);
    }
  });
  $("seed-random").addEventListener("click", () => {
    $("seed").value = Math.floor(Math.random() * 2147483647);
    syncDataBlock();
    saveSettings();
  });
  $("seed-clear").addEventListener("click", () => {
    $("seed").value = "";
    syncDataBlock();
    saveSettings();
  });
  $("generate-btn").addEventListener("click", generate);
  $("refresh-btn").addEventListener("click", () => loadGallery().catch(() => toast("刷新失败", true)));
}

/* ---------- 模式切换与图生图参考图 ---------- */

/* 切换文生图/图生图（按钮点击与整页拖图共用） */
function switchMode(id) {
  if (state.mode === id) return;
  state.mode = id;
  document.querySelectorAll("#mode-group button").forEach((x) => {
    const on = x.dataset.id === state.mode;
    x.setAttribute("aria-pressed", String(on));
    x.className = aspectClass(on);
  });
  applyModeUI();
  saveSettings();
}

const I2I_MAX_EDGE = 1536; // 参考图最长边上限（控制请求体积；服务端还会按比例裁缩）

export function renderMode() {
  const group = $("mode-group");
  group.innerHTML = "";
  [["t2i", "文生图"], ["i2i", "图生图"]].forEach(([id, label]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.dataset.id = id;
    b.setAttribute("aria-pressed", String(id === state.mode));
    b.className = aspectClass(id === state.mode);
    b.addEventListener("click", () => switchMode(id));
    group.appendChild(b);
  });
  applyModeUI();
}

/* 图生图面板显隐 + 生成按钮文案 */
function applyModeUI() {
  const i2i = state.mode === "i2i";
  $("i2i-panel").classList.toggle("hidden", !i2i);
  $("generate-btn").innerHTML =
    i2i ? "重绘 <span class=\"font-mono\">▸</span>" : "生成 <span class=\"font-mono\">▸</span>";
}

function setInitImage(b64, thumb) {
  state.initImage = b64 || null;
  state.initThumb = thumb || null;
  $("i2i-thumb").src = thumb || "";
  $("i2i-thumb").classList.toggle("hidden", !thumb);
  $("i2i-plus").classList.toggle("hidden", !!thumb);
  $("i2i-remove").classList.toggle("hidden", !thumb);
  saveSettings();
}

/* 读参考图：canvas 限制最长边后转 JPEG base64（服务端再按比例中心裁缩） */
function readInitImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    const scale = Math.min(1, I2I_MAX_EDGE / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; // 透明 PNG 转 JPEG 时避免黑底
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    setInitImage(dataUrl.split(",")[1], dataUrl);
  };
  img.onerror = () => { URL.revokeObjectURL(url); toast("图片读取失败", true); };
  img.src = url;
}

/* ---------- 示例提示词（来自 Krea 2 官方示例的风格方向） ---------- */

const EXAMPLES = [
  "雨后深夜的小巷，霓虹灯牌倒映在积水路面，电影感",
  "一只柴犬坐在铺满银杏叶的台阶上，秋日午后暖光，写实摄影",
  "漂浮在云海之上的悬浮岛屿，水彩风格，柔和晨光",
];

export function renderExamples() {
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
