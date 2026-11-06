/* 图生图参考图剪裁弹窗：按所选比例显示取景框，框内拖动移动、四角拖动按比例缩放。
   应用后把裁剪结果（JPEG base64）交回 studio.js，替换参考图并同步面板比例。
   取景框坐标用显示 px（相对 #crop-frame），应用时再换算到原图像素。 */
import { $, state, toast, aspectClass, MAX_IMAGE_EDGE } from "./core.js";
import { t } from "./i18n.js";

const MIN_BOX = 32; // 取景框最短边（显示 px）

const S = {
  aspectId: "1:1",
  ratio: 1,
  box: { x: 0, y: 0, w: 0, h: 0 }, // 显示 px，相对 #crop-frame
  drag: null, // {mode:"move"|"nw"|"ne"|"sw"|"se", p0, box, anchor}
  apply: null, // 应用回调：({ b64, thumb, aspectId }) => void
  open: false,
};

const frameEl = () => $("crop-frame");
const boxEl = () => $("crop-box");

function frameSize() {
  const f = frameEl();
  return { w: f.clientWidth, h: f.clientHeight };
}

/* "3:4" → 0.75；非法值退回 1 */
function ratioOf(id) {
  const [a, b] = String(id).split(":").map(Number);
  return a > 0 && b > 0 ? a / b : 1;
}

function pointInFrame(e) {
  const r = frameEl().getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function clampBox(b) {
  const { w: W, h: H } = frameSize();
  b.w = Math.min(b.w, W);
  b.h = Math.min(b.h, H);
  b.x = Math.min(Math.max(0, b.x), Math.max(0, W - b.w));
  b.y = Math.min(Math.max(0, b.y), Math.max(0, H - b.h));
  return b;
}

/* 取景框 DOM、框外压暗遮罩与实际裁剪像素尺寸回显 */
function syncBox() {
  const b = S.box;
  const el = boxEl();
  el.style.left = `${b.x}px`;
  el.style.top = `${b.y}px`;
  el.style.width = `${b.w}px`;
  el.style.height = `${b.h}px`;
  const { w: W, h: H } = frameSize();
  // 框外四块压暗（比 9999px 阴影便宜，也避免巨大 shadow 的合成开销）
  $("crop-dim-t").style.height = `${b.y}px`;
  $("crop-dim-b").style.height = `${Math.max(0, H - b.y - b.h)}px`;
  const side = (id, width) => {
    const e = $(id);
    e.style.top = `${b.y}px`;
    e.style.height = `${b.h}px`;
    e.style.width = `${Math.max(0, width)}px`;
  };
  side("crop-dim-l", b.x);
  side("crop-dim-r", W - b.x - b.w);
  const img = $("crop-base");
  if (img.naturalWidth && W && H) {
    $("crop-size").textContent =
      `${Math.round((b.w * img.naturalWidth) / W)} × ${Math.round((b.h * img.naturalHeight) / H)}`;
  }
}

/* 按当前比例取最大的框；keepCenter 时保留原框中心（换比例不跳位） */
function fitBox(keepCenter = false) {
  const { w: W, h: H } = frameSize();
  if (!W || !H) return;
  let w = W;
  let h = W / S.ratio;
  if (h > H) { h = H; w = H * S.ratio; }
  w = Math.max(1, Math.min(w, W));
  h = Math.max(1, Math.min(h, H));
  const cx = keepCenter ? S.box.x + S.box.w / 2 : W / 2;
  const cy = keepCenter ? S.box.y + S.box.h / 2 : H / 2;
  S.box = clampBox({ x: cx - w / 2, y: cy - h / 2, w, h });
  syncBox();
}

/* 图片按舞台可用空间等比缩放（可放大，方便小图取景），#crop-frame 随之等于显示尺寸。
   可显式传原始宽高：用缩略图已解码的尺寸先占位，避免弹窗首帧按原图尺寸撑开。 */
function fitImage(nw = 0, nh = 0) {
  const img = $("crop-base");
  const w0 = nw || img.naturalWidth;
  const h0 = nh || img.naturalHeight;
  if (!w0 || !h0) return;
  const stage = $("crop-stage");
  const availW = Math.max(80, stage.clientWidth - 24);
  const availH = Math.max(80, stage.clientHeight - 24);
  const scale = Math.min(availW / w0, availH / h0);
  img.style.width = `${Math.max(1, Math.round(w0 * scale))}px`;
  img.style.height = `${Math.max(1, Math.round(h0 * scale))}px`;
}

/* ---------- 比例按钮 ---------- */

function renderRatios() {
  const wrap = $("crop-ratios");
  wrap.innerHTML = "";
  const list = state.aspects.length ? state.aspects : [{ id: "1:1", name: "1:1" }];
  for (const a of list) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.cropRatio = a.id;
    b.textContent = a.id;
    b.title = a.name;
    wrap.appendChild(b);
  }
  syncRatios();
}

function syncRatios() {
  $("crop-ratios").querySelectorAll("[data-crop-ratio]").forEach((b) => {
    const on = b.dataset.cropRatio === S.aspectId;
    b.setAttribute("aria-pressed", String(on));
    b.className = `px-2.5 ${aspectClass(on)}`;
  });
}

/* ---------- 拖动 / 缩放 ---------- */

function startDrag(e) {
  if (!S.open) return;
  e.preventDefault();
  const handle = e.target.closest?.("[data-crop-handle]");
  const mode = handle ? handle.dataset.cropHandle : "move";
  const b = S.box;
  const anchors = {
    nw: { x: b.x + b.w, y: b.y + b.h },
    ne: { x: b.x, y: b.y + b.h },
    sw: { x: b.x + b.w, y: b.y },
    se: { x: b.x, y: b.y },
  };
  S.drag = { mode, p0: pointInFrame(e), box: { ...b }, anchor: anchors[mode] || null };
  try { boxEl().setPointerCapture(e.pointerId); } catch { /* 指针已失效则不捕获 */ }
  try { boxEl().focus({ preventScroll: true }); } catch { /* 老浏览器不支持 preventScroll */ }
}

function moveDrag(e) {
  const d = S.drag;
  if (!d) return;
  e.preventDefault();
  const p = pointInFrame(e);
  if (d.mode === "move") {
    S.box = clampBox({
      x: d.box.x + (p.x - d.p0.x),
      y: d.box.y + (p.y - d.p0.y),
      w: d.box.w,
      h: d.box.h,
    });
  } else {
    // 对角固定，宽高按比例取指针方向上的较大值，再夹进舞台可用空间
    const west = d.mode.includes("w");
    const north = d.mode.includes("n");
    const { w: W, h: H } = frameSize();
    const ax = d.anchor.x;
    const ay = d.anchor.y;
    const rawW = Math.abs(p.x - ax);
    const rawH = Math.abs(p.y - ay);
    const maxW = Math.min(west ? ax : W - ax, (north ? ay : H - ay) * S.ratio);
    let w = Math.max(rawW, rawH * S.ratio);
    w = Math.min(Math.max(w, Math.min(MIN_BOX, maxW)), maxW);
    const h = w / S.ratio;
    S.box = { x: west ? ax - w : ax, y: north ? ay - h : ay, w, h };
  }
  syncBox();
}

function endDrag(e) {
  if (!S.drag) return;
  S.drag = null;
  try { boxEl().releasePointerCapture(e.pointerId); } catch { /* 未捕获则忽略 */ }
}

/* 方向键微调（Shift 加速），保证键盘也能取景 */
function onBoxKey(e) {
  const step = e.shiftKey ? 10 : 2;
  const delta = {
    ArrowLeft: [-step, 0], ArrowRight: [step, 0],
    ArrowUp: [0, -step], ArrowDown: [0, step],
  }[e.key];
  if (!delta) return;
  e.preventDefault();
  S.box = clampBox({ ...S.box, x: S.box.x + delta[0], y: S.box.y + delta[1] });
  syncBox();
}

/* ---------- 打开 / 应用 / 关闭 ---------- */

export function openCrop() {
  if (!state.initThumb) { toast(t("先选择参考图再剪裁"), true); return; }
  const ids = state.aspects.map((a) => a.id);
  S.aspectId = ids.includes(state.aspect) ? state.aspect : (ids[0] || "1:1");
  S.ratio = ratioOf(S.aspectId);
  renderRatios();
  $("crop-dialog").classList.remove("hidden");
  S.open = true;
  $("crop-size").textContent = "—";
  const img = $("crop-base");
  // 缩略图已解码过，先用它的原始尺寸把图片与取景框摆好，再载入原图
  const thumb = $("i2i-thumb");
  if (thumb.naturalWidth) {
    fitImage(thumb.naturalWidth, thumb.naturalHeight);
    fitBox(false);
  }
  img.onload = () => { fitImage(); fitBox(false); };
  img.src = state.initThumb;
}

export function closeCrop() {
  if (!S.open) return;
  S.open = false;
  S.drag = null;
  $("crop-dialog").classList.add("hidden");
  $("crop-base").removeAttribute("src");
}

/* 把取景框里的内容裁出来：换算到原图像素 → 最长边不超过 MAX_IMAGE_EDGE → JPEG */
function applyCrop() {
  const img = $("crop-base");
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const { w: W, h: H } = frameSize();
  if (!iw || !ih || !W || !H) { closeCrop(); return; }
  const xScale = iw / W;
  const yScale = ih / H;
  const sx = Math.min(iw - 1, Math.max(0, Math.round(S.box.x * xScale)));
  const sy = Math.min(ih - 1, Math.max(0, Math.round(S.box.y * yScale)));
  const sw = Math.min(iw - sx, Math.max(1, Math.round(S.box.w * xScale)));
  const sh = Math.min(ih - sy, Math.max(1, Math.round(S.box.h * yScale)));
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(sw, sh));
  const cw = Math.max(1, Math.round(sw * scale));
  const ch = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // 透明 PNG 转 JPEG 时避免黑底（与参考图上传一致）
  ctx.fillRect(0, 0, cw, ch);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
  const aspectId = S.aspectId;
  closeCrop();
  S.apply?.({ b64: dataUrl.split(",")[1], thumb: dataUrl, aspectId });
  toast(t("已按 {ratio} 剪裁参考图", { ratio: aspectId }));
}

/* ---------- 装配 ---------- */

/* applyFn：应用剪裁后的回调（studio.js 提供，负责替换参考图并同步比例） */
export function bindCrop(applyFn) {
  S.apply = applyFn;
  $("i2i-crop").addEventListener("click", openCrop);
  $("crop-close").addEventListener("click", closeCrop);
  $("crop-cancel").addEventListener("click", closeCrop);
  $("crop-dialog").querySelector("[data-crop-close]").addEventListener("click", closeCrop);
  $("crop-apply").addEventListener("click", applyCrop);
  $("crop-ratios").addEventListener("click", (e) => {
    const b = e.target.closest?.("[data-crop-ratio]");
    if (!b) return;
    S.aspectId = b.dataset.cropRatio;
    S.ratio = ratioOf(S.aspectId);
    syncRatios();
    fitBox(true);
  });

  const box = boxEl();
  box.addEventListener("pointerdown", startDrag);
  box.addEventListener("pointermove", moveDrag);
  box.addEventListener("pointerup", endDrag);
  box.addEventListener("pointercancel", endDrag);
  box.addEventListener("dblclick", () => fitBox(false));
  box.addEventListener("keydown", onBoxKey);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && S.open) closeCrop();
  });

  // 窗口尺寸变化：重新适应图片并保留取景中心
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    if (!S.open) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!S.open) return;
      fitImage();
      fitBox(true);
    }, 120);
  });
}
