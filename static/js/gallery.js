/* 画廊：分页加载、卡片、删除；灯箱查看 */
import { $, state, toast, fmtTime, escapeHTML, escapeAttr } from "./core.js";

const GALLERY_PAGE = 60; // 与后端 GALLERY_PAGE_DEFAULT 对应

/* 「用这张重绘」回调：由 app 注入（studio.reuseAsRedraw），避免 gallery→studio 循环依赖 */
let redrawHandler = null;
export function setRedrawHandler(fn) {
  redrawHandler = fn;
}

function cardHTML(img) {
  const seedText = img.seed === null || img.seed === undefined ? "auto" : String(img.seed);
  const stylesText = (img.styles || []).map((s) => s.name).join(" · ")
    || img.style_name || "自由发挥";
  const roleText = img.role ? ` · ${img.role.name}` : "";
  return `
    <figure class="group relative border border-border rounded-md overflow-hidden bg-panel cursor-pointer" data-id="${img.id}" tabindex="0" role="button" aria-label="查看：${escapeAttr((img.prompt || "未命名图片").slice(0, 40))}">
      <div class="w-full aspect-[4/3] bg-panel-2 flex items-center justify-center overflow-hidden">
        <img src="${img.url}" alt="${escapeAttr(img.prompt || "生成的图片")}" loading="lazy" class="max-w-full max-h-full w-auto h-auto object-contain">
      </div>
      <figcaption class="absolute inset-x-0 bottom-0 hidden group-hover:block group-focus-within:block bg-paper/85 px-3 py-2">
        <div class="flex items-center gap-2 font-mono text-xs text-muted">
          <span class="text-ink truncate">${escapeHTML(stylesText + roleText)}</span>
          <span class="shrink-0">${img.width}×${img.height}</span>
          <span class="shrink-0">seed ${seedText}</span>
        </div>
      </figcaption>
      <button type="button" data-redraw="${img.id}" aria-label="用这张图重绘"
        class="absolute top-2 left-2 hidden group-hover:flex group-focus-within:flex items-center px-1.5 h-7 rounded-sm border border-border bg-paper text-muted hover:text-accent hover:border-accent transition-colors text-xs">重绘</button>
      <button type="button" data-del="${img.id}" aria-label="删除这张图片"
        class="absolute top-2 right-2 hidden group-hover:flex group-focus-within:flex w-7 h-7 items-center justify-center rounded-sm border border-border bg-paper text-muted hover:text-danger hover:border-danger transition-colors text-sm">×</button>
    </figure>`;
}

function buildCards(images) {
  const frag = document.createElement("template");
  frag.innerHTML = images.map(cardHTML).join("");
  frag.content.querySelectorAll("figure").forEach(bindCard);
  return frag.content;
}

/* 顶部插入（新生成的图）——供生成队列模块调用 */
export function insertCards(images) {
  if (!images.length) return;
  $("empty-state").classList.add("hidden");
  $("gallery").prepend(buildCards(images));
}

/* 尾部追加（画廊翻页） */
function appendCards(images) {
  if (!images.length) return;
  $("empty-state").classList.add("hidden");
  $("gallery").appendChild(buildCards(images));
}

export async function loadGallery() {
  const data = await fetch(`/api/images?limit=${GALLERY_PAGE}`).then((r) => r.json());
  state.images = data.items;
  state.galleryTotal = data.total;
  state.galleryHasMore = data.has_more;
  const gallery = $("gallery");
  gallery.innerHTML = "";
  $("gallery-count").textContent = String(state.galleryTotal);
  $("gallery-more").classList.toggle("hidden", !state.galleryHasMore);
  if (!state.images.length) {
    $("empty-state").classList.remove("hidden");
    return;
  }
  $("empty-state").classList.add("hidden");
  gallery.appendChild(buildCards(state.images));
}

/* 滚动到底加载下一页（游标 = 已载末条 created_at:id；加载期间插入的新图按 id 去重） */
async function loadMoreGallery() {
  if (!state.galleryHasMore || state.loadingMore) return;
  const last = state.images[state.images.length - 1];
  if (!last) return;
  state.loadingMore = true;
  $("gallery-more").classList.remove("hidden");
  try {
    const cursor = encodeURIComponent(`${last.created_at}:${last.id}`);
    const data = await fetch(`/api/images?limit=${GALLERY_PAGE}&before=${cursor}`)
      .then((r) => r.json());
    const known = new Set(state.images.map((i) => i.id));
    const fresh = data.items.filter((i) => !known.has(i.id));
    state.images.push(...fresh);
    state.galleryHasMore = data.has_more;
    appendCards(fresh);
    $("gallery-count").textContent = String(state.galleryTotal);
  } catch { /* 拉取失败静默，滚动再试 */ } finally {
    state.loadingMore = false;
    $("gallery-more").classList.toggle("hidden", !state.galleryHasMore);
  }
}

/* 画廊底部哨兵：进入视口（提前 400px）即翻页 */
export function bindGalleryScroll() {
  new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) loadMoreGallery();
  }, { rootMargin: "400px" }).observe($("gallery-sentinel"));
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
  fig.querySelector("[data-redraw]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const img = state.images.find((i) => i.id === fig.dataset.id);
    if (img && redrawHandler) redrawHandler(img);
  });
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
  state.galleryTotal = Math.max(0, state.galleryTotal - 1);
  $("gallery-count").textContent = String(state.galleryTotal);
  document.querySelector(`figure[data-id="${CSS.escape(id)}"]`)?.remove();
  if (!state.images.length) $("empty-state").classList.remove("hidden");
  if (lightboxId === id) closeLightbox();
  toast("已删除");
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
    ["风格", (img.styles || []).map((s) => s.name).join(" · ") || img.style_name || "—"],
    ...(img.role ? [["角色", img.role.name]] : []),
    ...(img.common ? [["通用词", img.common]] : []),
    ["尺寸", img.width ? `${img.width}×${img.height}` : "—"],
    ["步数", img.steps || "—"],
    ["种子", seedText],
    ...((img.rounds || 1) > 1 ? [["次数", `${img.rounds} 轮 · 每轮 ${img.batch || 1} 张`]] : []),
    ...(img.strength != null ? [["重绘幅度", Number(img.strength).toFixed(2)]] : []),
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

export function bindLightbox() {
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
