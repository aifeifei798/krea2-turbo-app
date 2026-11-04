/* 精细选区弹窗：放大画布涂抹（滚轮以光标为中心缩放、抓手平移）。
   笔迹与主画布共享（图像像素坐标，经 inpaint.js 的访问器读写）；由 app.js 装配 bindFine。 */
import { $, toast } from "./core.js";
import { t } from "./i18n.js";
import { MASK_COLOR, drawPath, replayOverlay, getStrokes, pushStroke,
         popStroke, getBrushSize, setBrushSize, hasBase } from "./inpaint.js";

const fine = {
  fit: 1,        // 适应窗口的基础缩放（显示px/图像px）
  zoom: 1,       // 相对适应窗口的倍率
  eff: 1,        // = fit × zoom，实际缩放
  pan: { x: 0, y: 0 },
  tool: "brush", // brush | eraser | pan
  stroke: null,  // 正在画的笔迹
  panFrom: null, // 正在平移 {sx, sy, px, py}
};
let fineRingEl = null;

function fineApply() {
  $("fine-inner").style.transform =
    `translate(${fine.pan.x}px, ${fine.pan.y}px) scale(${fine.eff})`;
  $("fine-zoom-val").textContent = `${Math.round(fine.zoom * 100)}%`;
}

function fineFit() {
  const img = $("fine-base");
  const stage = $("fine-stage");
  const scale = Math.min(stage.clientWidth / img.naturalWidth,
                         stage.clientHeight / img.naturalHeight);
  fine.fit = scale;
  fine.zoom = 1;
  fine.eff = scale;
  fine.pan = {
    x: (stage.clientWidth - img.naturalWidth * scale) / 2,
    y: (stage.clientHeight - img.naturalHeight * scale) / 2,
  };
  fineApply();
}

function fineReplay() {
  const c = $("fine-canvas");
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  for (const s of getStrokes()) {
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

/* 客户端坐标 → 图像像素（含平移与缩放） */
function fineToImage(e) {
  const rect = $("fine-stage").getBoundingClientRect();
  return {
    x: (e.clientX - rect.left - fine.pan.x) / fine.eff,
    y: (e.clientY - rect.top - fine.pan.y) / fine.eff,
  };
}

function syncFineTools() {
  document.querySelectorAll("[data-fine-tool]").forEach((b) => {
    const on = b.dataset.fineTool === fine.tool;
    b.setAttribute("aria-pressed", String(on));
    b.className = `px-2 py-1 inline-flex items-center gap-1 rounded-sm border font-mono text-xs transition-colors ${on
      ? "border-accent bg-accent-dim text-accent"
      : "border-border bg-panel text-muted hover:border-accent hover:text-ink"}`;
  });
  $("fine-stage").style.cursor = fine.tool === "pan" ? "grab" : "none";
}

function fineRingMove(e) {
  const rect = $("fine-stage").getBoundingClientRect();
  if (!fineRingEl) {
    fineRingEl = $("fine-ring");
    fineRingEl.style.cssText +=
      ";position:absolute;pointer-events:none;border-radius:50%;" +
      "border:1.5px solid rgba(255,255,255,.95);" +
      "box-shadow:0 0 0 1px rgba(0,0,0,.55),inset 0 0 0 1px rgba(0,0,0,.35);";
  }
  const d = getBrushSize();
  fineRingEl.style.width = `${d}px`;
  fineRingEl.style.height = `${d}px`;
  fineRingEl.style.borderStyle = fine.tool === "eraser" ? "dashed" : "solid";
  fineRingEl.style.transform =
    `translate(${e.clientX - rect.left - d / 2}px, ${e.clientY - rect.top - d / 2}px)`;
  fineRingEl.classList.remove("hidden");
}

function fineSegment(ctx, from, to, size, erase) {
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

function fineClose() {
  $("fine-dialog").classList.add("hidden");
  if (fineRingEl) fineRingEl.classList.add("hidden");
  fine.stroke = null;
  fine.panFrom = null;
  replayOverlay(); // 弹窗里的新笔迹同步回主画布
}

/* 画笔大小与主面板同一个值（滑杆里存的是 100% 缩放下的显示 px） */
function syncFineSize() {
  const n = getBrushSize();
  $("fine-size").value = String(n);
  $("fine-size-val").textContent = String(n);
}

function openFineDialog() {
  if (!hasBase()) { toast(t("先上传图片再用精细选区"), true); return; }
  const img = $("fine-base");
  img.onload = () => {
    const c = $("fine-canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.style.width = `${img.naturalWidth}px`;
    c.style.height = `${img.naturalHeight}px`;
    fineFit();
    fineReplay();
  };
  img.src = $("inpaint-base").src;
  fine.tool = "brush";
  syncFineTools();
  syncFineSize();
  $("fine-dialog").classList.remove("hidden");
}

export function bindFine() {
  $("inpaint-fine").addEventListener("click", openFineDialog);
  $("fine-done").addEventListener("click", fineClose);
  $("fine-dialog").querySelector("[data-fine-close]").addEventListener("click", fineClose);
  document.querySelectorAll("[data-fine-tool]").forEach((b) =>
    b.addEventListener("click", () => {
      fine.tool = b.dataset.fineTool;
      syncFineTools();
    }));
  $("fine-undo").addEventListener("click", () => {
    if (getStrokes().length) { popStroke(); fineReplay(); }
  });
  $("fine-fit").addEventListener("click", fineFit);
  $("fine-size").addEventListener("input", () => {
    setBrushSize($("fine-size").value);      // 同时更新主面板滑杆、数值与主画布笔圈
    $("fine-size-val").textContent = String(getBrushSize());
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("fine-dialog").classList.contains("hidden")) fineClose();
  });

  const stage = $("fine-stage");
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const nz = Math.min(12, Math.max(1, fine.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    if (nz === fine.zoom) return;
    // 保持光标下的图像点不动
    const ix = (cx - fine.pan.x) / fine.eff;
    const iy = (cy - fine.pan.y) / fine.eff;
    fine.eff = fine.fit * nz;
    fine.zoom = nz;
    fine.pan.x = cx - ix * fine.eff;
    fine.pan.y = cy - iy * fine.eff;
    fineApply();
  }, { passive: false });

  stage.addEventListener("pointerdown", (e) => {
    if (!hasBase()) return;
    e.preventDefault();
    try { stage.setPointerCapture(e.pointerId); } catch { /* 指针已失效则不捕获 */ }
    if (fine.tool === "pan") {
      fine.panFrom = { sx: e.clientX, sy: e.clientY, px: fine.pan.x, py: fine.pan.y };
      return;
    }
    const p = fineToImage(e);
    // 画笔大小 = 主面板滑杆值（弹窗屏幕像素）；放大后覆盖的图像像素更少、涂抹更精细
    const size = Math.max(2, Math.round(getBrushSize() / fine.eff));
    fine.stroke = { points: [p], size, erase: fine.tool === "eraser" };
    fineSegment($("fine-canvas").getContext("2d"), p, p, size, fine.stroke.erase);
  });
  stage.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") { if (fineRingEl) fineRingEl.classList.add("hidden"); return; }
    if (fine.tool !== "pan") fineRingMove(e);
    if (fine.panFrom) {
      fine.pan.x = fine.panFrom.px + e.clientX - fine.panFrom.sx;
      fine.pan.y = fine.panFrom.py + e.clientY - fine.panFrom.sy;
      fineApply();
      return;
    }
    if (fine.stroke) {
      const p = fineToImage(e);
      const last = fine.stroke.points[fine.stroke.points.length - 1];
      fine.stroke.points.push(p);
      fineSegment($("fine-canvas").getContext("2d"), last, p,
                  fine.stroke.size, fine.stroke.erase);
    }
  });
  const fineEnd = () => {
    if (fine.stroke) { pushStroke(fine.stroke); fine.stroke = null; }
    fine.panFrom = null;
  };
  stage.addEventListener("pointerup", fineEnd);
  stage.addEventListener("pointercancel", fineEnd);
  stage.addEventListener("pointerleave", () => {
    if (fineRingEl) fineRingEl.classList.add("hidden");
  });
}
