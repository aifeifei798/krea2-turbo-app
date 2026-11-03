/* 画廊：分页加载、卡片、删除。灯箱拆在 lightbox.js（经 registerLightbox 回调，依赖单向） */
import { $, state, toast, escapeHTML, escapeAttr, apiFetch } from "./core.js";
import { t } from "./i18n.js";

const GALLERY_PAGE = 60; // 与后端 GALLERY_PAGE_DEFAULT 对应

/* 「用这张重绘」回调：由 app 注入（studio.reuseAsRedraw），避免 gallery→studio 循环依赖 */
let redrawHandler = null;
export function setRedrawHandler(fn) {
  redrawHandler = fn;
}

/* 「修图」回调：由 app 注入（studio.reuseAsInpaint）；灯箱经 getInpaintHandler 取用 */
let inpaintHandler = null;
export function setInpaintHandler(fn) {
  inpaintHandler = fn;
}
export function getInpaintHandler() {
  return inpaintHandler;
}

/* 灯箱开/关注册（lightbox.js bind 时注入；画廊只管调，不知道灯箱细节） */
let lightboxApi = null;
export function registerLightbox(api) {
  lightboxApi = api;
}

function cardHTML(img) {
  const seedText = img.seed === null || img.seed === undefined ? "auto" : String(img.seed);
  const stylesText = (img.styles || []).map((s) => s.name).join(" · ")
    || img.style_name || t("自由发挥");
  const roleText = img.role ? ` · ${img.role.name}` : "";
  return `
    <figure class="group relative border border-border rounded-md overflow-hidden bg-panel cursor-pointer" data-id="${img.id}" tabindex="0" role="button" aria-label="${escapeAttr(t("查看：{s}", { s: (img.prompt || t("未命名图片")).slice(0, 40) }))}">
      <div class="w-full aspect-[4/3] bg-panel-2 flex items-center justify-center overflow-hidden">
        <img src="${img.url}" alt="${escapeAttr(img.prompt || t("生成的图片"))}" loading="lazy" class="max-w-full max-h-full w-auto h-auto object-contain">
      </div>
      <figcaption class="absolute inset-x-0 bottom-0 hidden group-hover:block group-focus-within:block bg-paper/85 px-3 py-2">
        <div class="flex items-center gap-2 font-mono text-xs text-muted">
          <span class="text-ink truncate">${escapeHTML(stylesText + roleText)}</span>
          <span class="shrink-0">${img.width}×${img.height}</span>
          <span class="shrink-0">seed ${seedText}</span>
        </div>
      </figcaption>
      <button type="button" data-redraw="${img.id}" aria-label="${t("用这张图重绘")}"
        class="absolute top-2 left-2 hidden group-hover:flex group-focus-within:flex items-center px-1.5 h-7 rounded-sm border border-border bg-paper text-muted hover:text-accent hover:border-accent transition-colors text-xs">${t("重绘")}</button>
      <button type="button" data-del="${img.id}" aria-label="${t("删除这张图片")}"
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
  const data = await apiFetch(`/api/images?limit=${GALLERY_PAGE}`).then((r) => r.json());
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
    const data = await apiFetch(`/api/images?limit=${GALLERY_PAGE}&before=${cursor}`)
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
  const open = () => lightboxApi?.open(fig.dataset.id);
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

export async function deleteImage(id) {
  try {
    const res = await apiFetch(`/api/images/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    toast(t("删除失败：{m}", { m: e.message }), true);
    return;
  }
  state.images = state.images.filter((i) => i.id !== id);
  state.galleryTotal = Math.max(0, state.galleryTotal - 1);
  $("gallery-count").textContent = String(state.galleryTotal);
  document.querySelector(`figure[data-id="${CSS.escape(id)}"]`)?.remove();
  if (!state.images.length) $("empty-state").classList.remove("hidden");
  lightboxApi?.closeIf(id);
  toast(t("已删除"));
}



/* 语言切换后重建卡片（已加载的窗口内本地重绘，不重新拉取） */
document.addEventListener("langchange", () => {
  const gallery = $("gallery");
  gallery.innerHTML = "";
  if (state.images.length) gallery.appendChild(buildCards(state.images));
});
