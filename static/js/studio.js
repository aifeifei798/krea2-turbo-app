/* 制作面板：预设渲染、比例/步数/批量/次数/种子绑定、模式切换与图生图参考图 */
import { $, state, toast, aspectClass, syncDataBlock } from "./core.js";
import { t } from "./i18n.js";
import { savedSettings, saveSettings } from "./settings.js";
import { syncStyleSummary } from "./picker.js";
import { syncCommonBadge } from "./common-words.js";
import { generate } from "./queue.js";
import { loadGallery } from "./gallery.js";
import { loadInpaintFile } from "./inpaint.js";

export function renderPresets(data) {
  state.styles = data.styles;
  state.roles = data.roles || [];
  state.aspects = data.aspects;
  state.maxSteps = data.max_steps;
  state.maxStyles = data.max_styles || 4;
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
    else toast(t("请拖入图片文件"), true);
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
    if (e.target.closest?.("#i2i-drop") || e.target.closest?.("#inpaint-drop")) return;
    e.preventDefault(); // 上传框自己的 handler 已处理
    const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith("image/"));
    if (!file) return;
    // 按当前模式路由：文生图顺手切到图生图，修图模式进修图画布
    if (state.mode === "inpaint") loadInpaintFile(file);
    else {
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
  $("refresh-btn").addEventListener("click", () => loadGallery().catch(() => toast(t("刷新失败"), true)));
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
  [["t2i", "文生图"], ["i2i", "图生图"], ["inpaint", "修图"]].forEach(([id, label]) => {
    label = t(label);
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

/* 各模式面板显隐 + 生成按钮文案 */
function applyModeUI() {
  const i2i = state.mode === "i2i";
  const inpaint = state.mode === "inpaint";
  $("i2i-panel").classList.toggle("hidden", !i2i);
  $("inpaint-panel").classList.toggle("hidden", !inpaint);
  $("aspect-row").classList.toggle("hidden", inpaint); // 修图：尺寸跟原图
  $("generate-btn").innerHTML =
    i2i ? `${t("重绘")} <span class="font-mono">▸</span>`
      : inpaint ? `${t("修图")} <span class="font-mono">▸</span>`
        : `${t("生成")} <span class="font-mono">▸</span>`;
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
  readInitImageFromBlob(file);
}

function readInitImageFromBlob(blob) {
  const url = URL.createObjectURL(blob);
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
  img.onerror = () => { URL.revokeObjectURL(url); toast(t("图片读取失败"), true); };
  img.src = url;
}

/* 画廊/灯箱「修图」：切修图模式 + 该图进画布 + 回填提示词 */
export function reuseAsInpaint(img) {
  switchMode("inpaint");
  $("prompt").value = img.prompt || "";
  syncDataBlock();
  saveSettings();
  fetch(img.url)
    .then((r) => r.blob())
    .then(loadInpaintFile)
    .catch(() => toast(t("参考图读取失败"), true));
  toast(t("已带入修图，用画笔涂抹要重绘的部位"));
  $("prompt").focus();
}

/* 画廊「用这张重绘」：切图生图 + 历史图作参考图 + 回填当时的提示词/风格/角色 */
export function reuseAsRedraw(img) {
  switchMode("i2i");
  $("prompt").value = img.prompt || "";
  state.selectedStyles = (img.styles || [])
    .map((s) => s.id)
    .filter((id) => state.styles.some((s) => s.id === id));
  state.selectedRole =
    img.role && state.roles.some((r) => r.id === img.role.id) ? img.role.id : null;
  state.commonWords = img.common || "";
  if (img.aspect_id && state.aspects.some((a) => a.id === img.aspect_id)) {
    state.aspect = img.aspect_id;
    $("aspect-group").querySelectorAll("button").forEach((x) => {
      const on = x.dataset.id === state.aspect;
      x.setAttribute("aria-pressed", String(on));
      x.className = aspectClass(on);
    });
  }
  if (img.steps) $("steps").value = Math.min(Number($("steps").max) || 16, img.steps);
  syncStyleSummary();
  syncCommonBadge();
  syncDataBlock();
  saveSettings();
  fetch(img.url)
    .then((r) => r.blob())
    .then(readInitImageFromBlob)
    .catch(() => toast(t("参考图读取失败"), true));
  toast(t("已带入图生图，调整幅度后重绘"));
  $("prompt").focus();
}

/* ---------- 示例提示词（来自 Krea 2 官方示例的风格方向） ---------- */

const EXAMPLES = [
  "雨后深夜的小巷，霓虹灯牌倒映在积水路面，电影感",
  "一只柴犬坐在铺满银杏叶的台阶上，秋日午后暖光，写实摄影",
  "漂浮在云海之上的悬浮岛屿，水彩风格，柔和晨光",
];

export function renderExamples() {
  const box = $("example-prompts");
  box.innerHTML = "";
  EXAMPLES.forEach((p) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = t(p);
    b.className = "px-3 py-2 rounded-sm border border-border bg-panel text-left text-xs text-muted hover:border-accent hover:text-ink transition-colors";
    b.addEventListener("click", () => {
      $("prompt").value = t(p);
      $("prompt").focus();
    });
    box.appendChild(b);
  });
}

document.addEventListener("langchange", () => {
  renderMode();
  renderExamples();
});
