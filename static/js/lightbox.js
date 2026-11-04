/* 灯箱：大图查看、详情元数据、下载/复制/删除/送修图、翻页（按钮+方向键+滚轮）。
   从 gallery.js 拆出；画廊经 registerLightbox 拿到开/关能力（依赖单向 lightbox → gallery）。 */
import { $, state, toast, fmtTime, escapeHTML, escapeAttr } from "./core.js";
import { t } from "./i18n.js";
import { deleteImage, getInpaintHandler, registerLightbox } from "./gallery.js";

let lightboxId = null;
let deleteArmed = false;
let deleteTimer = null;

/* 图生图/修图前后对比：中间线分割原图与新图，开启后按住图片任意位置左右拖动
   （左=原图，右=新图）。原图优先用生成时落盘的 outputs/src/{id}.jpg（与成品逐像素对齐），
   旧修图数据回退到画廊里的 source_id 原图 */
let compareOn = false;
let compareSrc = null;

function setComparePos(pct) {
  pct = Math.max(0, Math.min(100, pct));
  $("lb-compare-img").style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
  $("lb-compare-bar").style.left = `${pct}%`;
}

function setCompare(on) {
  compareOn = on;
  $("lb-compare-img").src = compareSrc || "";
  $("lb-compare-img").classList.toggle("hidden", !on);
  $("lb-compare-bar").classList.toggle("hidden", !on);
  $("lb-compare-tag-l").classList.toggle("hidden", !on);
  $("lb-compare-tag-r").classList.toggle("hidden", !on);
  // 拖动目标是整张图而非细线：开启时整图变左右拖动光标、禁掉触屏滚动
  $("lb-imgzone").classList.toggle("cursor-ew-resize", on);
  $("lb-imgzone").classList.toggle("touch-none", on);
  $("lb-compare-btn").classList.toggle("text-accent", on);
  if (on) setComparePos(50);
}

function openLightbox(id) {
  const img = state.images.find((i) => i.id === id);
  if (!img) return;
  lightboxId = id;
  disarmDelete();
  // 有「改图前」原图就自动开启对比（探测加载成功后）；失败则连按钮一起藏
  setCompare(false);
  $("lb-compare-btn").classList.add("hidden");
  compareSrc = null;
  const srcUrl = img.src ? `/outputs/src/${img.id}.jpg`
    : (img.source_id ? `/outputs/${img.source_id}.jpg` : null);
  if (srcUrl) {
    const probe = new Image();
    probe.onload = () => {
      if (lightboxId !== id) return;
      compareSrc = srcUrl;
      $("lb-compare-btn").classList.remove("hidden");
      setCompare(true);
    };
    probe.onerror = () => { if (lightboxId === id) $("lb-compare-btn").classList.add("hidden"); };
    probe.src = srcUrl;
  }
  $("lb-img").src = img.url;
  $("lb-img").alt = img.prompt || t("生成的图片");
  $("lb-prompt").textContent = img.prompt || t("（提示词缺失）");
  const seedText = img.seed === null || img.seed === undefined ? "auto" : String(img.seed);
  const loraText = (img.loras || []).map((l) => `${l.name} ${l.weight.toFixed(2)}`).join(" · ");
  $("lb-meta").innerHTML = [
    [t("风格"), (img.styles || []).map((s) => s.name).join(" · ") || img.style_name || "—"],
    ...(img.role ? [[t("角色"), img.role.name]] : []),
    ...(img.common ? [[t("通用词"), img.common]] : []),
    [t("尺寸"), img.width ? `${img.width}×${img.height}` : "—"],
    [t("步数"), img.steps || "—"],
    [t("种子"), seedText],
    ...((img.rounds || 1) > 1 ? [[t("次数"), t("{a} 轮 · 每轮 {b} 张", { a: img.rounds, b: img.batch || 1 })]] : []),
    ...(img.strength != null ? [[t("重绘幅度"), Number(img.strength).toFixed(2)]] : []),
    ...(loraText ? [[t("LoRA"), loraText]] : []),
    [t("时间"), img.created_at ? fmtTime(img.created_at) : "—"],
    [t("模型"), img.model || "Krea 2 Turbo"],
    [t("完整提示词"), img.full_prompt || "—"],
  ].map(([k, v]) => `<div class="flex gap-2"><dt class="shrink-0">${k}</dt><dd class="text-ink truncate" title="${escapeAttr(v)}">${escapeHTML(v)}</dd></div>`).join("");
  $("lb-download").href = img.url;
  $("lb-download").setAttribute("download", `${id}.jpg`);
  const idx = state.images.findIndex((i) => i.id === lightboxId);
  const prevEnd = idx <= 0;
  const nextEnd = idx === -1 || idx >= state.images.length - 1;
  // 图两侧圆形按钮与下方文字按钮同步置灰
  document.querySelectorAll("[data-lb-prev]").forEach((b) => (b.disabled = prevEnd));
  document.querySelectorAll("[data-lb-next]").forEach((b) => (b.disabled = nextEnd));
  $("lightbox").classList.remove("hidden");
  $("lb-close").focus();
}

/* 灯箱内前后翻页（按钮 + 左右方向键共用） */
function lightboxNav(delta) {
  const idx = state.images.findIndex((i) => i.id === lightboxId);
  if (idx === -1) return;
  const neighbor = state.images[idx + delta];
  if (neighbor) openLightbox(neighbor.id);
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
  btn.querySelector("span").textContent = t("删除"); // 只改文字，保住图标
  btn.classList.remove("text-danger", "border-danger");
}

export function bindLightbox() {
  registerLightbox({
    open: openLightbox,
    closeIf: (id) => { if (lightboxId === id) closeLightbox(); },
  });
  $("lb-close").addEventListener("click", closeLightbox);
  $("lightbox").querySelector("[data-close]").addEventListener("click", closeLightbox);
  document.addEventListener("keydown", (e) => {
    if ($("lightbox").classList.contains("hidden")) return;
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowLeft") lightboxNav(-1);
    else if (e.key === "ArrowRight") lightboxNav(1);
  });
  document.querySelectorAll("[data-lb-prev]").forEach((b) => b.addEventListener("click", () => lightboxNav(-1)));
  document.querySelectorAll("[data-lb-next]").forEach((b) => b.addEventListener("click", () => lightboxNav(1)));
  /* 图片上滚轮翻页：滚上=上一张、滚下=下一张。累积阈值+冷却防触控板惯性连翻；
     只挂在图片区（详情面板自留滚动），preventDefault 防止滚透到底下页面 */
  let wheelAcc = 0;
  let wheelLock = 0;
  let wheelIdleTimer = 0;
  $("lb-imgzone").addEventListener("wheel", (e) => {
    e.preventDefault();
    clearTimeout(wheelIdleTimer);
    wheelIdleTimer = setTimeout(() => (wheelAcc = 0), 400);
    const now = Date.now();
    if (now < wheelLock) return;
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) >= 60) {
      lightboxNav(wheelAcc < 0 ? -1 : 1);
      wheelAcc = 0;
      wheelLock = now + 300;
    }
  }, { passive: false });
  $("lb-copy").addEventListener("click", async () => {
    const img = state.images.find((i) => i.id === lightboxId);
    if (!img?.prompt) { toast(t("这张图没有提示词可复制"), true); return; }
    try {
      await navigator.clipboard.writeText(img.prompt);
      toast(t("提示词已复制"));
    } catch {
      toast(t("复制失败（浏览器未授权剪贴板）"), true);
    }
  });
  $("lb-delete").addEventListener("click", () => {
    if (!deleteArmed) {
      deleteArmed = true;
      const btn = $("lb-delete");
      btn.querySelector("span").textContent = t("确认删除？");
      btn.classList.add("text-danger", "border-danger");
      deleteTimer = setTimeout(disarmDelete, 3000);
      return;
    }
    if (lightboxId) deleteImage(lightboxId);
  });
  // 前后对比拖动：按住图片任意位置左右拖（pointer 捕获），中间细线只是视觉指示；
  // 翻页按钮不参与拖动
  const zone = $("lb-imgzone");
  zone.addEventListener("pointerdown", (e) => {
    if (!compareOn || e.target.closest("button, a")) return;
    e.preventDefault();
    try { zone.setPointerCapture(e.pointerId); } catch { /* 指针已失效则不捕获 */ }
    const move = (ev) => {
      const rect = zone.getBoundingClientRect();
      setComparePos(((ev.clientX - rect.left) / rect.width) * 100);
    };
    move(e);
    const up = () => {
      zone.removeEventListener("pointermove", move);
      zone.removeEventListener("pointerup", up);
      zone.removeEventListener("pointercancel", up);
    };
    zone.addEventListener("pointermove", move);
    zone.addEventListener("pointerup", up);
    zone.addEventListener("pointercancel", up);
  });
  $("lb-compare-btn").addEventListener("click", () => setCompare(!compareOn));
  // 灯箱直接送修图：生成 → 挑毛病 → 就地涂抹重绘
  $("lb-inpaint").addEventListener("click", () => {
    const img = state.images.find((i) => i.id === lightboxId);
    if (!img) return;
    closeLightbox();
    const handler = getInpaintHandler();
    if (handler) handler(img);
  });
}
