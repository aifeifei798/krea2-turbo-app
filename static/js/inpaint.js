/* 修图模式：上传图片 + 画笔涂抹蒙版（画笔/橡皮/撤销/清空），提交时导出白笔迹黑底蒙版。
   笔迹以图像像素坐标存储（与显示尺寸无关），蒙版导出带轻微羽化供后端软合成。 */
import { $, state, toast, aspectClass, syncDataBlock, MAX_IMAGE_EDGE } from "./core.js";
import { t } from "./i18n.js";
import { savedSettings, saveSettings } from "./settings.js";

/* 蒙版预览固有色：画在不透明离屏层上，再整体半透明合成 —— 叠几遍都不会加深，
   这样"看到的红色深浅"永远等于"真实蒙版覆盖"（导出的蒙版本身是实心 255） */
export const MASK_COLOR = "#ff3b3b";
const MASK_ALPHA = 0.7;

/* 离屏蒙版层：ctx(w,h,clear) 取上下文（尺寸变了自动重建）；blit 半透明贴回显示画布 */
export function maskLayer() {
  let canvas = null;
  return {
    ctx(w, h, clear = false) {
      if (!canvas) canvas = document.createElement("canvas");
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const c = canvas.getContext("2d");
      if (clear) c.clearRect(0, 0, w, h);
      return c;
    },
    blit(target, w, h) {
      if (!canvas) return;
      target.clearRect(0, 0, w, h);
      target.save();
      target.globalAlpha = MASK_ALPHA;
      target.drawImage(canvas, 0, 0);
      target.restore();
    },
  };
}

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

/* 载入要修的图片（Blob）：压缩到 MAX_IMAGE_EDGE、清空笔迹、展示编辑器。
   sourceId：从画廊/灯箱带入的源图 id（手动上传则为 null），供修图结果前后对比 */
export function loadInpaintFile(blob, sourceId = null) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.width, img.height));
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
    state.inpaintSourceId = sourceId;
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
  img.onerror = () => { URL.revokeObjectURL(url); toast(t("图片读取失败"), true); };
  img.src = url;
}

/* 移除图片：回空态 */
export function clearInpaintImage() {
  baseB64 = null;
  strokes = [];
  cur = null;
  state.inpaintSourceId = null;
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

export function drawPath(ctx, points) {
  // 单点笔迹用 0.01px 偏移保证圆头端点可见（零长度线段部分浏览器不画）
  if (points.length === 1) {
    ctx.lineTo(points[0].x + 0.01, points[0].y + 0.01);
    return;
  }
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
}

const previewLayer = maskLayer();

function drawSegment(from, to, size, erase) {
  const c = $("inpaint-canvas");
  if (!c.width) return;
  const lctx = previewLayer.ctx(c.width, c.height);
  lctx.save();
  if (erase) lctx.globalCompositeOperation = "destination-out";
  lctx.lineCap = "round";
  lctx.lineJoin = "round";
  lctx.strokeStyle = MASK_COLOR;
  lctx.lineWidth = size;
  lctx.beginPath();
  lctx.moveTo(from.x, from.y);
  lctx.lineTo(to.x + 0.01, to.y + 0.01);
  lctx.stroke();
  lctx.restore();
  previewLayer.blit(c.getContext("2d"), c.width, c.height);
}

/* 把一条笔迹画到 ctx 上：brush = 圆头描边，lasso = 闭合多边形填充。
   预览层、蒙版导出、精细弹窗三处共用，避免三份各画一套。 */
export function paintStroke(ctx, s, color) {
  ctx.save();
  if (s.erase) ctx.globalCompositeOperation = "destination-out";
  if (s.kind === "lasso") {
    const pts = s.points;
    if (pts.length < 3) { ctx.restore(); return; }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = color;
    ctx.lineWidth = s.size;
    ctx.beginPath();
    drawPath(ctx, s.points);
    ctx.stroke();
  }
  ctx.restore();
}

/* 按笔迹列表重铺整个预览层（载图/撤销/清空后；精细弹窗关闭时也经此同步） */
export function replayOverlay() {
  const c = $("inpaint-canvas");
  const img = $("inpaint-base");
  if (!img.naturalWidth) return;
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const lctx = previewLayer.ctx(c.width, c.height, true);
  for (const s of strokes) paintStroke(lctx, s, MASK_COLOR);
  previewLayer.blit(c.getContext("2d"), c.width, c.height);
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
  for (const s of strokes) paintStroke(hctx, s, "#fff");
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

/* 圆环尺寸/样式随画笔大小与工具变化（橡皮=虚线圈；套索改用十字光标） */
function syncRing() {
  const r = ensureRing();
  r.style.width = `${brushSize}px`;
  r.style.height = `${brushSize}px`;
  r.style.borderStyle = tool === "eraser" ? "dashed" : "solid";
  r.style.display = tool === "lasso" ? "none" : "block";
  $("inpaint-canvas").style.cursor = tool === "lasso" ? "crosshair" : "none";
}

function moveRing(e) {
  if (tool === "lasso") return; // 套索没有"笔刷大小"，用十字光标
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

/* 套索进行中：先重铺已提交笔迹，再叠一层虚线轮廓 + 半透明填充（松手才落成实心） */
function drawLassoLive() {
  replayOverlay();
  const c = $("inpaint-canvas");
  const ctx = c.getContext("2d");
  const pts = cur.points;
  const width = Math.max(2, Math.round(c.width / 400));
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  if (pts.length > 2) {
    ctx.closePath();
    ctx.fillStyle = "rgba(255, 60, 60, 0.18)";
    ctx.fill();
  }
  ctx.setLineDash([width * 3, width * 2]);
  ctx.lineWidth = width;
  ctx.strokeStyle = MASK_COLOR;
  ctx.stroke();
  ctx.restore();
}

function startStroke(e) {
  if (!baseB64) return;
  e.preventDefault();
  try { $("inpaint-canvas").setPointerCapture(e.pointerId); } catch { /* 指针已失效则不捕获 */ }
  const p = toImagePoint(e);
  if (tool === "lasso") {
    cur = { kind: "lasso", points: [{ x: p.x, y: p.y }] }; // 松手时自动闭合
    hideRing();
    drawLassoLive();
    return;
  }
  cur = { points: [p], size: p.size, erase: tool === "eraser" };
  drawSegment(p, p, cur.size, cur.erase);
}

function moveStroke(e) {
  if (!cur) return;
  e.preventDefault();
  const p = toImagePoint(e);
  if (cur.kind === "lasso") {
    const last = cur.points[cur.points.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) < 2) return; // 去抖：少铺几遍全图
    cur.points.push({ x: p.x, y: p.y });
    drawLassoLive();
    return;
  }
  const last = cur.points[cur.points.length - 1];
  cur.points.push(p);
  drawSegment(last, p, cur.size, cur.erase);
}

function endStroke() {
  if (!cur) return;
  const wasLasso = cur.kind === "lasso";
  const tooSmall = wasLasso && cur.points.length < 3; // 一次点击/抖动不足，不成圈就丢掉
  if (!tooSmall) strokes.push(cur);
  cur = null;
  if (wasLasso) replayOverlay(); // 把预览的虚线换成实心填充
  saveSettings();
}

/* ---------- 装配 ---------- */

function syncTools() {
  document.querySelectorAll("[data-inpaint-tool]").forEach((b) => {
    const on = b.dataset.inpaintTool === tool;
    b.setAttribute("aria-pressed", String(on));
    b.className = `inline-flex items-center gap-1 px-2 shrink-0 ${aspectClass(on)}`;
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
    else toast(t("请拖入图片文件"), true);
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
    setBrushSize($("inpaint-brush").value);
  });
  $("inpaint-undo").addEventListener("click", () => {
    if (strokes.length) { strokes.pop(); replayOverlay(); }
  });
  $("inpaint-clear").addEventListener("click", () => {
    if (strokes.length) { strokes = []; replayOverlay(); toast(t("已清空涂抹")); }
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

/* ---------- 供 inpaint-fine.js 使用的共享接口（依赖单向 fine → inpaint） ---------- */

export const getStrokes = () => strokes;        // 笔迹数组引用（涂完 push、撤销 pop）
export const pushStroke = (s) => strokes.push(s);
export const popStroke = () => strokes.pop();
export const getBrushSize = () => brushSize;    // 主面板滑杆值（显示 px）
export const setBrushSize = (n) => {            // 精细弹窗与主面板共用同一份笔刷大小
  brushSize = Math.min(80, Math.max(6, Math.round(Number(n) || 28)));
  $("inpaint-brush").value = String(brushSize);
  $("inpaint-brush-val").textContent = String(brushSize);
  syncRing();
};
export const hasBase = () => baseB64 !== null;  // 是否已载图
