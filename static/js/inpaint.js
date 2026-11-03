/* 修图模式：上传图片 + 画笔涂抹蒙版（画笔/橡皮/撤销/清空），提交时导出白笔迹黑底蒙版。
   笔迹以图像像素坐标存储（与显示尺寸无关），蒙版导出带轻微羽化供后端软合成。 */
import { $, state, toast, aspectClass, syncDataBlock } from "./core.js";
import { savedSettings, saveSettings } from "./settings.js";

const MAX_EDGE = 1536; // 原图压缩上限（与图生图一致；服务端同值兜底）
const MASK_COLOR = "rgba(255, 60, 60, 0.55)"; // 涂抹预览色

let baseB64 = null; // 压缩后的原图 base64（不含 data: 前缀）
let strokes = []; // {points:[{x,y}], size(图像px), erase} —— 图像像素坐标
let tool = "brush"; // brush | eraser
let brushSize = 28; // 画笔大小（显示 px，转图像 px 存进笔迹）
let cur = null; // 正在画的一笔

export function hasMask() {
  return baseB64 !== null && strokes.length > 0;
}

/* 提交给 /api/generate 的修图载荷；未载图或没涂抹返回 null */
export function getInpaintPayload() {
  if (!baseB64 || !strokes.length) return null;
  const img = $("inpaint-base");
  return {
    init_image: baseB64,
    mask_image: exportMask(),
    width: img.naturalWidth,
    height: img.naturalHeight,
  };
}

/* 载入要修的图片（Blob）：压缩到 MAX_EDGE、清空笔迹、展示编辑器 */
export function loadInpaintFile(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; // 透明图兜底填充，避免黑底
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    // PNG 无损：蒙版外要逐像素贴回原图，JPEG 压缩噪声会破坏保真合成
    const dataUrl = canvas.toDataURL("image/png");
    baseB64 = dataUrl.split(",")[1];
    strokes = [];
    $("inpaint-thumb").src = dataUrl;
    $("inpaint-thumb").classList.remove("hidden");
    $("inpaint-plus").classList.add("hidden");
    $("inpaint-remove").classList.remove("hidden");
    state.inpaintDims = { width: w, height: h };
    const disp = $("inpaint-base");
    disp.onload = replayOverlay; // 解码完成再铺画布（否则 naturalWidth 还是 0）
    disp.src = dataUrl;
    $("inpaint-editor").classList.remove("hidden");
    syncDataBlock();
    saveSettings();
  };
  img.onerror = () => { URL.revokeObjectURL(url); toast("图片读取失败", true); };
  img.src = url;
}

/* 移除图片：回空态 */
export function clearInpaintImage() {
  baseB64 = null;
  strokes = [];
  cur = null;
  $("inpaint-thumb").src = "";
  $("inpaint-thumb").classList.add("hidden");
  $("inpaint-plus").classList.remove("hidden");
  $("inpaint-remove").classList.add("hidden");
  $("inpaint-base").src = "";
  $("inpaint-editor").classList.add("hidden");
  state.inpaintDims = null;
  syncDataBlock();
  saveSettings();
}

/* ---------- 蒙版渲染与导出 ---------- */

function drawPath(ctx, points) {
  // 单点笔迹用 0.01px 偏移保证圆头端点可见（零长度线段部分浏览器不画）
  if (points.length === 1) {
    ctx.lineTo(points[0].x + 0.01, points[0].y + 0.01);
    return;
  }
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
}

function drawSegment(ctx, from, to, size, erase) {
  ctx.save();
  if (erase) ctx.globalCompositeOperation = "destination-out";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = MASK_COLOR;
  ctx.lineWidth = size;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x + 0.01, to.y + 0.01);
  ctx.stroke();
  ctx.restore();
}

/* 按笔迹列表重铺整个预览层（载图/撤销/清空后） */
function replayOverlay() {
  const c = $("inpaint-canvas");
  const img = $("inpaint-base");
  if (!img.naturalWidth) return;
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d");
  for (const s of strokes) {
    ctx.save();
    if (s.erase) ctx.globalCompositeOperation = "destination-out";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = MASK_COLOR;
    ctx.lineWidth = s.size;
    ctx.beginPath();
    drawPath(ctx, s.points);
    ctx.stroke();
    ctx.restore();
  }
}

/* 导出蒙版：黑底白笔迹，整体轻微羽化（后端软合成 + 潜变量重注入共用） */
function exportMask() {
  const img = $("inpaint-base");
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const hard = document.createElement("canvas");
  hard.width = w;
  hard.height = h;
  const hctx = hard.getContext("2d");
  hctx.fillStyle = "#000";
  hctx.fillRect(0, 0, w, h);
  hctx.lineCap = "round";
  hctx.lineJoin = "round";
  hctx.strokeStyle = "#fff";
  for (const s of strokes) {
    hctx.save();
    if (s.erase) hctx.globalCompositeOperation = "destination-out";
    hctx.lineWidth = s.size;
    hctx.beginPath();
    drawPath(hctx, s.points);
    hctx.stroke();
    hctx.restore();
  }
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d");
  octx.fillStyle = "#000";
  octx.fillRect(0, 0, w, h);
  octx.filter = `blur(${Math.max(2, Math.round(w * 0.004))}px)`;
  octx.drawImage(hard, 0, 0);
  return out.toDataURL("image/png").split(",")[1];
}

/* ---------- 画笔光圈：跟随指针的圆环，直径=画笔大小（显示 px） ---------- */

let ring = null;

function ensureRing() {
  if (ring) return ring;
  ring = document.createElement("div");
  ring.style.cssText =
    "position:absolute;left:0;top:0;pointer-events:none;border-radius:50%;" +
    "border:1.5px solid rgba(255,255,255,.95);" +
    "box-shadow:0 0 0 1px rgba(0,0,0,.55),inset 0 0 0 1px rgba(0,0,0,.35);";
  $("inpaint-canvas").parentElement.appendChild(ring);
  return ring;
}

/* 圆环尺寸/样式随画笔大小与工具变化（橡皮=虚线圈） */
function syncRing() {
  const r = ensureRing();
  r.style.width = `${brushSize}px`;
  r.style.height = `${brushSize}px`;
  r.style.borderStyle = tool === "eraser" ? "dashed" : "solid";
}

function moveRing(e) {
  const c = $("inpaint-canvas");
  const rect = c.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const r = ensureRing();
  r.style.transform = `translate(${x - brushSize / 2}px, ${y - brushSize / 2}px)`;
  r.style.display = "block";
}

function hideRing() {
  if (ring) ring.style.display = "none";
}

/* ---------- 指针涂抹（鼠标/触屏统一 pointer events） ---------- */

/* 客户端坐标 → 图像像素坐标；画笔大小同步换算成图像 px */
function toImagePoint(e) {
  const c = $("inpaint-canvas");
  const rect = c.getBoundingClientRect();
  const scaleX = c.width / rect.width;
  const scaleY = c.height / rect.height;
  return {
    x: Math.round((e.clientX - rect.left) * scaleX),
    y: Math.round((e.clientY - rect.top) * scaleY),
    size: Math.max(4, Math.round(brushSize * scaleX)),
  };
}

function startStroke(e) {
  if (!baseB64) return;
  e.preventDefault();
  try { $("inpaint-canvas").setPointerCapture(e.pointerId); } catch { /* 指针已失效则不捕获 */ }
  const p = toImagePoint(e);
  cur = { points: [p], size: p.size, erase: tool === "eraser" };
  drawSegment($("inpaint-canvas").getContext("2d"), p, p, cur.size, cur.erase);
}

function moveStroke(e) {
  if (!cur) return;
  e.preventDefault();
  const p = toImagePoint(e);
  const last = cur.points[cur.points.length - 1];
  cur.points.push(p);
  drawSegment($("inpaint-canvas").getContext("2d"), last, p, cur.size, cur.erase);
}

function endStroke() {
  if (!cur) return;
  strokes.push(cur);
  cur = null;
  saveSettings();
}

/* ---------- 装配 ---------- */

function syncTools() {
  document.querySelectorAll("[data-inpaint-tool]").forEach((b) => {
    const on = b.dataset.inpaintTool === tool;
    b.setAttribute("aria-pressed", String(on));
    b.className = aspectClass(on);
  });
}

export function bindInpaint() {
  brushSize = Number(savedSettings.inpaintBrush) || 28;
  $("inpaint-brush").value = brushSize;
  $("inpaint-brush-val").textContent = String(brushSize);
  if (typeof savedSettings.inpaintStrength === "number") {
    $("inpaint-strength").value = savedSettings.inpaintStrength;
  }
  $("inpaint-strength-val").textContent = Number($("inpaint-strength").value).toFixed(2);
  syncTools();
  syncRing();

  // 上传：点击 / 键盘 / 拖入 / 移除
  $("inpaint-drop").addEventListener("click", () => $("inpaint-file").click());
  $("inpaint-drop").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("inpaint-file").click(); }
  });
  $("inpaint-file").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) loadInpaintFile(file);
    e.target.value = ""; // 允许重复选择同一文件
  });
  $("inpaint-drop").addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  $("inpaint-drop").addEventListener("drop", (e) => {
    e.preventDefault();
    const file = [...(e.dataTransfer.files || [])].find((f) => f.type.startsWith("image/"));
    if (file) loadInpaintFile(file);
    else toast("请拖入图片文件", true);
  });
  $("inpaint-remove").addEventListener("click", (e) => {
    e.stopPropagation();
    clearInpaintImage();
  });

  // 工具行
  document.querySelectorAll("[data-inpaint-tool]").forEach((b) =>
    b.addEventListener("click", () => {
      tool = b.dataset.inpaintTool;
      syncTools();
      syncRing();
    }));
  $("inpaint-brush").addEventListener("input", () => {
    brushSize = Number($("inpaint-brush").value);
    $("inpaint-brush-val").textContent = String(brushSize);
    syncRing();
  });
  $("inpaint-undo").addEventListener("click", () => {
    if (strokes.length) { strokes.pop(); replayOverlay(); }
  });
  $("inpaint-clear").addEventListener("click", () => {
    if (strokes.length) { strokes = []; replayOverlay(); toast("已清空涂抹"); }
  });
  $("inpaint-strength").addEventListener("input", () => {
    $("inpaint-strength-val").textContent = Number($("inpaint-strength").value).toFixed(2);
  });

  // 画布涂抹 + 画笔光圈（触摸设备无悬停，不显示圆环）
  const c = $("inpaint-canvas");
  c.addEventListener("pointerdown", startStroke);
  c.addEventListener("pointermove", moveStroke);
  c.addEventListener("pointerup", endStroke);
  c.addEventListener("pointercancel", endStroke);
  c.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") { hideRing(); return; }
    moveRing(e);
  });
  c.addEventListener("pointerdown", (e) => { if (e.pointerType === "touch") hideRing(); });
  c.addEventListener("pointerup", (e) => { if (e.pointerType === "touch") hideRing(); });
  c.addEventListener("pointerleave", hideRing);
}
