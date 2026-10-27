import * as pdfjsLib from "/static/vendor/pdfjs/pdf.min.mjs";
import { initMindmap } from "/static/mindmap.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/vendor/pdfjs/pdf.worker.min.mjs";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined) el.append(kid);
  return el;
};

const BACKEND_INFO = {
  claude_cli: ["Claude Code", "本机的 claude 命令，走你的 Claude 订阅，不需要 API key"],
  anthropic: ["Anthropic API", "用 API key 直接调 Claude（全文会被 prompt cache，追问很便宜）"],
  codex: ["Codex CLI", "本机的 codex 命令，走你的 ChatGPT 订阅（不流式，答完一次性显示）"],
  openai: ["本地模型 / OpenAI 兼容接口", "Ollama、LM Studio、vLLM、OpenAI 等任何 /v1/chat/completions 接口"],
  mock: ["测试", "不调用模型，只回显收到了什么，用来检查界面"],
};
const BACKEND_FIELDS = {
  claude_cli: [["model", "模型", "text", "留空=默认；可填 opus / sonnet / haiku 或完整模型名"], ["path", "claude 路径", "text", "留空自动查找"]],
  anthropic: [["model", "模型", "text", "claude-opus-5-5"], ["api_key", "API key", "password", "留空则用环境变量 ANTHROPIC_API_KEY"],
    ["effort", "思考程度", "select:low,medium,high,xhigh,max"], ["base_url", "Base URL", "text", "留空=官方"]],
  codex: [["model", "模型", "text", "留空=codex 默认"], ["path", "codex 路径", "text", "留空自动查找"]],
  openai: [["base_url", "Base URL", "text", "http://localhost:11434/v1"], ["model", "模型", "text", "例如 qwen2.5vl:7b"],
    ["api_key", "API key", "password", "本地模型一般不需要"], ["vision", "支持图片", "checkbox"],
    ["max_context_chars", "上下文字符上限", "number", "60000"]],
  mock: [],
};
const ACTION_LABEL = { explain: "解释", math: "推导", simple: "通俗讲", connect: "联系全文", critique: "挑毛病" };

const state = {
  settings: null, detected: {}, papers: [],
  paper: null, threads: [], memory: { notes: "", figures: [], qa: [], info: {} }, digestStatus: "none", digestPhase: "",
  pdf: null, pages: [], zoom: 1, visible: new Set(),
  activeThread: null, pending: null, regionMode: false,
  streaming: {}, // threadId -> text being streamed
  streamTools: {}, // threadId -> tool calls made while streaming
  aborts: {}, // threadId -> AbortController of the running answer
  live: {}, // threadId -> {pid, thread, mode} for answers still streaming
  drafts: {}, // threadId -> follow-up being typed
  anchors: null, // where figures / equations / sections / references are
  backStack: [], // scroll positions to return to after following a link
};

// --------------------------------------------------------------------------- utils

function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

async function readSSE(resp, onEvent) {
  if (!resp.ok) {
    let msg = resp.statusText;
    try { msg = (await resp.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data) onEvent(JSON.parse(data));
    }
  }
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\\w$])\$(?![\s$])((?:\\\$|[^$\n])+?)(?<![\s\\])\$(?![\w$])/g;

function renderMD(src) {
  const codes = [];
  src = src.replace(/```[\s\S]*?(?:```|$)|`[^`\n]+`/g, (m) => `\u0001C${codes.push(m) - 1}\u0001`);
  const maths = [];
  src = src.replace(MATH_RE, (m, a, b, c, d) => {
    maths.push({ tex: a ?? b ?? c ?? d, display: a !== undefined || b !== undefined });
    return `KXMATH${maths.length - 1}XK`;
  });
  src = src.replace(/\u0001C(\d+)\u0001/g, (_, i) => codes[i]);
  const html = DOMPurify.sanitize(marked.parse(src, { gfm: true }), { ADD_ATTR: ["target"] });
  return html.replace(/KXMATH(\d+)XK/g, (_, i) => {
    const m = maths[i];
    try { return katex.renderToString(m.tex, { displayMode: m.display, throwOnError: false }); }
    catch { return esc(m.tex); }
  });
}

// Ordinary links in answers and notes open in a new tab (in the Mac app: the default browser).
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("href") && !node.getAttribute("href").startsWith("#")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener");
  }
});

const rafQueue = new Map();
function renderLater(el, fn) {
  if (rafQueue.has(el)) { rafQueue.set(el, fn); return; }
  rafQueue.set(el, fn);
  requestAnimationFrame(() => { const f = rafQueue.get(el); rafQueue.delete(el); f(); });
}

// Enter that only confirms an IME candidate (Chinese input) must not send anything.
// WebKit ends the composition before that keydown, so check keyCode 229 as well.
const composing = (e) => e.isComposing || e.keyCode === 229;

function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
}

// --------------------------------------------------------------------------- settings

async function loadSettings() {
  const r = await api("/api/settings");
  state.settings = r.settings;
  state.detected = r.detected;
  $("#backend-name").textContent = BACKEND_INFO[state.settings.backend][0];
  renderModeSwitch();
}

function renderModeSwitch() {
  const mode = state.settings.context_mode || "memory";
  $$("#mode-switch button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
}

async function setMode(mode) {
  const s = JSON.parse(JSON.stringify(state.settings));
  s.context_mode = mode;
  await api("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(s) });
  await loadSettings();
  toast(mode === "memory" ? "记忆模式：只发论文记忆和当前页，细节让模型自己查原文" : "全文模式：每次都附上整篇论文原文");
}

function openSettings() {
  const s = JSON.parse(JSON.stringify(state.settings));
  const form = $("#settings-form");
  const choices = $("#backend-choices");
  const fields = $("#backend-fields");
  choices.innerHTML = "";
  const det = state.detected;
  const status = { claude_cli: det.claude_cli ? "✓ 找到 claude" : "✗ 没找到 claude 命令", codex: det.codex ? "✓ 找到 codex" : "✗ 没找到 codex 命令" };
  let current = s.backend;
  const drawFields = () => {
    fields.innerHTML = "";
    for (const [key, label, type, ph] of BACKEND_FIELDS[current]) {
      const cfg = s.backends[current];
      let input;
      if (type.startsWith("select:")) {
        input = h("select", { name: key }, type.slice(7).split(",").map((o) => h("option", { selected: cfg[key] === o }, o)));
      } else if (type === "checkbox") {
        input = h("input", { type: "checkbox", name: key });
        input.checked = !!cfg[key];
      } else {
        input = h("input", { type, name: key, placeholder: ph || "" });
        input.value = cfg[key] ?? "";
      }
      input.addEventListener("change", () => {
        cfg[key] = type === "checkbox" ? input.checked : type === "number" ? Number(input.value) : input.value.trim();
      });
      fields.append(h("label", {}, h("span", {}, label), input));
    }
  };
  for (const [key, [name, desc]] of Object.entries(BACKEND_INFO)) {
    const radio = h("input", { type: "radio", name: "backend", value: key });
    radio.checked = key === current;
    const st = status[key] ? h("small", { class: status[key].startsWith("✓") ? "ok" : "warn" }, status[key]) : null;
    const lab = h("label", { class: key === current ? "sel" : "" }, radio, h("div", {}, h("b", {}, name), h("small", {}, desc), st));
    radio.addEventListener("change", () => {
      current = key;
      $$("label", choices).forEach((l) => l.classList.toggle("sel", l === lab));
      drawFields();
    });
    choices.append(lab);
  }
  drawFields();
  form.language.value = s.language;
  form.auto_digest.checked = s.auto_digest;
  form.attach_image_for_text.checked = s.attach_image_for_text;
  form.distill_qa.checked = s.distill_qa !== false;
  const dlg = $("#settings");
  dlg.onclose = async () => {
    if (dlg.returnValue !== "save") return;
    // Commit the active field (change may not have fired yet).
    $$("input, select", fields).forEach((el) => el.dispatchEvent(new Event("change")));
    s.backend = current;
    s.language = form.language.value;
    s.auto_digest = form.auto_digest.checked;
    s.attach_image_for_text = form.attach_image_for_text.checked;
    s.distill_qa = form.distill_qa.checked;
    await api("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(s) });
    await loadSettings();
    toast(`已切换到 ${BACKEND_INFO[s.backend][0]}`);
  };
  dlg.returnValue = "";
  dlg.showModal();
}

// --------------------------------------------------------------------------- library

async function loadLibrary() {
  state.papers = await api("/api/papers");
  const ul = $("#paper-list");
  ul.innerHTML = "";
  if (!state.papers.length) ul.append(h("li", { class: "hint" }, "还没有论文"));
  for (const p of state.papers) {
    const meta = [`${p.num_pages} 页`, p.has_notes ? "已通读" : null, p.n_threads ? `${p.n_threads} 个问题` : null].filter(Boolean).join(" · ");
    const del = h("button", {
      class: "del", title: "删除",
      onclick: async (e) => {
        e.stopPropagation();
        if (!confirm(`删除《${p.title}》和它的所有问答？`)) return;
        await api(`/api/papers/${p.id}`, { method: "DELETE" });
        if (state.paper?.id === p.id) closePaper();
        loadLibrary();
      },
    }, "删除");
    ul.append(h("li", { class: state.paper?.id === p.id ? "active" : "", onclick: () => openPaper(p.id), title: p.title },
      h("div", { class: "t" }, p.title), h("div", { class: "m" }, meta), del));
  }
}

async function uploadFiles(files) {
  let last;
  for (const f of files) {
    if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) { toast(`${f.name} 不是 PDF`); continue; }
    const fd = new FormData();
    fd.append("file", f);
    toast(`正在导入 ${f.name}…`);
    try { last = await api("/api/papers", { method: "POST", body: fd }); }
    catch (e) { toast(`导入失败：${e.message}`); }
  }
  await loadLibrary();
  if (last) openPaper(last.id);
}

async function importUrl(url) {
  toast("正在下载…", 20000);
  try {
    const meta = await api("/api/papers/url", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
    toast(`已导入：${meta.title}`);
    await loadLibrary();
    openPaper(meta.id);
  } catch (e) { toast(`导入失败：${e.message}`); }
}

// --------------------------------------------------------------------------- paper

function closePaper() {
  state.openSeq = (state.openSeq || 0) + 1;
  state.paper = null;
  state.pdf?.destroy();
  state.pdf = null;
  state.pages = [];
  state.threads = [];
  state.memory = { notes: "", figures: [], qa: [], info: {} };
  state.anchors = null;
  state.backStack = [];
  updateBackBtn();
  renderThreads();
  renderMemoryBar();
  renderMine();
  $("#pages").innerHTML = "";
  $("#empty-state").hidden = false;
  $("#viewer-tools").hidden = true;
  $("#paper-title").textContent = "interpretability";
  $("#threads").innerHTML = "";
  $("#memory").innerHTML = "";
}

async function openPaper(id) {
  if (state.paper?.id === id && state.pdf) return; // already open
  const tok = (state.openSeq = (state.openSeq || 0) + 1);
  mm?.onPaperChange();
  hidePopup();
  await flushMyNotes();
  const r = await api(`/api/papers/${id}`);
  if (tok !== state.openSeq) return; // a later click won
  state.paper = r.meta;
  state.threads = mergeLiveThreads(id, r.threads);
  state.anchors = null;
  previewCache.clear();
  state.memory = r.memory || { notes: r.notes || "", figures: [], qa: [], info: {} };
  state.digestStatus = r.digest_status;
  state.digestPhase = r.digest_phase;
  state.activeThread = null;
  state.activeNote = null;
  state.mineEditing = undefined;
  localStorage.setItem("pr.last", id);
  $("#paper-title").textContent = r.meta.title;
  $("#empty-state").hidden = true;
  $("#viewer-tools").hidden = false;
  $$("#paper-list li").forEach((li, i) => li.classList.toggle("active", state.papers[i]?.id === id));
  renderThreads();
  renderMemory();
  renderMine();
  if (state.digestStatus === "running") followDigest(id);

  state.pdf?.destroy();
  state.pdf = null;
  state.pages = [];
  $("#pages").innerHTML = "";
  const pdf = await pdfjsLib.getDocument({
    url: `/api/papers/${id}/pdf`,
    cMapUrl: "/static/vendor/pdfjs/cmaps/", cMapPacked: true,
    standardFontDataUrl: "/static/vendor/pdfjs/standard_fonts/",
  }).promise;
  if (tok !== state.openSeq) return pdf.destroy();
  state.pdf = pdf;
  state.backStack = [];
  updateBackBtn();
  loadAnchors(id);
  await buildPages(pdf, tok);
  if (tok === state.openSeq) $("#viewer").scrollTop = 0;
}

async function buildPages(pdf, tok) {
  const container = $("#pages");
  container.innerHTML = "";
  state.pages = [];
  state.visible.clear();
  observer.disconnect();
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    if (tok !== state.openSeq) return; // another paper was opened meanwhile
    const base = page.getViewport({ scale: 1 });
    const div = h("div", { class: "page", "data-page": n - 1 }, h("div", { class: "hl-layer" }));
    container.append(div);
    const pv = { idx: n - 1, page, base, div, scale: 0, rendering: null };
    state.pages.push(pv);
    observer.observe(div);
  }
  fitWidth();
  renderHighlights();
  updatePageIndicator();
}

function fitWidth() {
  if (!state.pages.length) return;
  const w = $("#viewer").clientWidth - 40;
  const maxW = Math.max(...state.pages.map((p) => p.base.width));
  setZoom(Math.min(w / maxW, 2.2));
  state.fitMode = true;
}

function setZoom(z) {
  state.fitMode = false;
  const viewer = $("#viewer");
  const ratio = viewer.scrollTop / Math.max(1, viewer.scrollHeight);
  state.zoom = Math.max(0.4, Math.min(4, z));
  $("#zoom-ind").textContent = Math.round(state.zoom * 100) + "%";
  for (const pv of state.pages) {
    pv.div.style.width = pv.base.width * state.zoom + "px";
    pv.div.style.height = pv.base.height * state.zoom + "px";
  }
  viewer.scrollTop = ratio * viewer.scrollHeight;
  renderHighlights();
  pumpRender();
}

const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const idx = Number(e.target.dataset.page);
    const pv = state.pages[idx];
    if (!pv) continue;
    if (e.isIntersecting) state.visible.add(idx);
    else { state.visible.delete(idx); unrenderPage(pv); }
  }
  pumpRender();
}, { root: $("#viewer"), rootMargin: "800px 0px" });

// Render one page at a time, nearest to the middle of the viewport first.
let pumping = false;
async function pumpRender() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const viewer = $("#viewer");
      const mid = viewer.scrollTop + viewer.clientHeight / 2;
      const dist = (pv) => Math.abs(pv.div.offsetTop + pv.div.offsetHeight / 2 - mid);
      const todo = [...state.visible].map((i) => state.pages[i])
        .filter((pv) => pv && pv.scale !== state.zoom && pv.failed !== state.zoom)
        .sort((a, b) => dist(a) - dist(b));
      if (!todo.length) break;
      await renderPage(todo[0]);
    }
  } finally {
    pumping = false;
  }
}

async function renderPage(pv) {
  const scale = state.zoom;
  if (pv.scale === scale || pv.rendering === scale) return;
  pv.rendering = scale;
  const viewport = pv.page.getViewport({ scale });
  const dpr = window.devicePixelRatio || 1;
  const canvas = h("canvas");
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  const textDiv = h("div", { class: "textLayer" });
  try {
    await pv.page.render({ canvasContext: canvas.getContext("2d"), viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
    if (pv.rendering !== scale) return;
    pv.div.style.setProperty("--scale-factor", scale);
    const tl = new pdfjsLib.TextLayer({ textContentSource: pv.page.streamTextContent(), container: textDiv, viewport });
    await tl.render();
    if (pv.rendering !== scale) return;
    textDiv.append(h("div", { class: "endOfContent" }));
    const links = await linkLayer(pv);
    if (pv.rendering !== scale) return;
    $$("canvas, .textLayer, .link-layer", pv.div).forEach((el) => el.remove());
    pv.div.prepend(canvas, textDiv, links);
    pv.scale = scale;
  } catch (e) {
    pv.failed = scale;
    if (e?.name !== "RenderingCancelledException") console.error(e);
  } finally {
    if (pv.rendering === scale) pv.rendering = null;
  }
}

function unrenderPage(pv) {
  $$("canvas, .textLayer, .link-layer", pv.div).forEach((el) => el.remove());
  pv.scale = 0;
  pv.rendering = null;
}

function updatePageIndicator() {
  if (!state.pages.length) return;
  const top = $("#viewer").getBoundingClientRect().top + 80;
  let cur = 0;
  for (const pv of state.pages) if (pv.div.getBoundingClientRect().top <= top) cur = pv.idx;
  $("#page-ind").textContent = `${cur + 1} / ${state.pages.length}`;
}

function scrollToSelection(sel) {
  const pv = state.pages[sel.page];
  if (!pv) return;
  const viewer = $("#viewer");
  const y = pv.div.offsetTop + sel.bbox[1] * pv.div.offsetHeight - viewer.clientHeight * 0.3;
  const pr = pv.div.getBoundingClientRect(), vr = viewer.getBoundingClientRect();
  const absTop = pr.top + sel.bbox[1] * pr.height, absBot = pr.top + sel.bbox[3] * pr.height;
  if (absTop < vr.top + 40 || absBot > vr.bottom - 40) viewer.scrollTo({ top: y, behavior: "smooth" });
}

function jumpToPage(n) {
  const pv = state.pages[n];
  if (pv) $("#viewer").scrollTo({ top: pv.div.offsetTop - 10 });
}

// --------------------------------------------------------------------------- highlights
// Highlights only show where questions were asked; they never take the mouse, so you can
// still select text or draw a box over them. Each thread gets a numbered pin in the page
// margin, and a plain click on highlighted text also opens its thread.

const threadNo = (t) => state.threads.indexOf(t) + 1;
const threadSelections = (t) => [t.selection, ...t.messages.map((m) => m.selection)].filter(Boolean);
const pct = (r) => `left:${r[0] * 100}%;top:${r[1] * 100}%;width:${(r[2] - r[0]) * 100}%;height:${(r[3] - r[1]) * 100}%`;

function renderHighlights() {
  for (const pv of state.pages) $(".hl-layer", pv.div).innerHTML = "";
  const pins = new Map(); // page -> [{top, el}]
  for (const t of state.threads) {
    const pinned = new Set();
    for (const s of threadSelections(t)) {
      const pv = state.pages[s.page];
      if (!pv) continue;
      const layer = $(".hl-layer", pv.div);
      const active = t.id === state.activeThread ? "active" : "";
      for (const r of s.kind === "region" ? [s.bbox] : s.rects || [s.bbox]) {
        layer.append(h("div", { class: `hl ${s.kind === "region" ? "region" : ""} ${active}`, "data-thread": t.id, style: pct(r) }));
      }
      if (pinned.has(s.page)) continue;
      pinned.add(s.page);
      const pin = h("button", {
        class: `hl-pin ${active}`, "data-thread": t.id, title: `#${threadNo(t)} ${threadSummary(t)}`,
        style: `top:${s.bbox[1] * 100}%`,
        onclick: (e) => { e.stopPropagation(); activateThread(t.id === state.activeThread ? null : t.id, { scrollPanel: true }); },
        onmouseenter: () => $$(`.hl[data-thread="${t.id}"]`).forEach((el) => el.classList.add("hover")),
        onmouseleave: () => $$(".hl.hover").forEach((el) => el.classList.remove("hover")),
        onmousedown: (e) => e.stopPropagation(),
      }, String(threadNo(t)));
      layer.append(pin);
      if (!pins.has(s.page)) pins.set(s.page, []);
      pins.get(s.page).push({ top: s.bbox[1], el: pin });
    }
  }
  // The reader's own highlights and margin notes: colored, with a ✎ pin in the left margin.
  const notePins = new Map();
  for (const a of state.memory.annotations || []) {
    const pv = state.pages[a.page];
    if (!pv) continue;
    const layer = $(".hl-layer", pv.div);
    const active = a.id === state.activeNote ? "active" : "";
    for (const r of a.kind === "region" ? [a.bbox] : a.rects || [a.bbox]) {
      layer.append(h("div", { class: `hl note c-${a.color} ${a.kind === "region" ? "region" : ""} ${active}`, "data-note": a.id, style: pct(r) }));
    }
    if (!a.note?.trim()) continue; // plain highlight, no pin
    const pin = h("button", {
      class: `note-pin c-${a.color} ${active}`, title: a.note.slice(0, 120), style: `top:${a.bbox[1] * 100}%`,
      onclick: (e) => { e.stopPropagation(); openNote(a.id); },
      onmouseenter: () => $$(`.hl[data-note="${a.id}"]`).forEach((el) => el.classList.add("hover")),
      onmouseleave: () => $$(".hl.hover").forEach((el) => el.classList.remove("hover")),
      onmousedown: (e) => e.stopPropagation(),
    }, "✎");
    layer.append(pin);
    if (!notePins.has(a.page)) notePins.set(a.page, []);
    notePins.get(a.page).push({ top: a.bbox[1], el: pin });
  }
  stackPins(notePins, "left");
  stackPins(pins, "right");
}

// Pins that would overlap move inward, one slot each.
function stackPins(pins, side) {
  for (const [page, list] of pins) {
    const hPx = state.pages[page].div.offsetHeight || 1000;
    list.sort((a, b) => a.top - b.top);
    const placed = [];
    for (const p of list) {
      let slot = 0;
      while (placed.some((q) => q.slot === slot && Math.abs(q.top - p.top) * hPx < 22)) slot++;
      placed.push({ top: p.top, slot });
      p.el.style[side] = `${4 + slot * 24}px`;
    }
  }
}

// What is under a click: a Q&A thread or one of the reader's notes (the smallest wins).
function markAt(pageIdx, x, y) {
  let best = null, bestArea = Infinity;
  const consider = (sel, item) => {
    if (sel.page !== pageIdx) return;
    for (const r of sel.kind === "region" ? [sel.bbox] : sel.rects || [sel.bbox]) {
      const area = (r[2] - r[0]) * (r[3] - r[1]);
      if (x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3] && area < bestArea) { best = item; bestArea = area; }
    }
  };
  for (const t of state.threads) for (const s of threadSelections(t)) consider(s, { thread: t });
  for (const a of state.memory.annotations || []) consider(a, { note: a });
  return best;
}

function showPending(sel) {
  $$(".pending-sel").forEach((el) => el.remove());
  if (!sel) return;
  const layer = state.pages[sel.page].div;
  for (const r of sel.kind === "region" ? [sel.bbox] : sel.rects) {
    layer.append(h("div", { class: `pending-sel ${sel.kind}`, style: pct(r) }));
  }
}

// --------------------------------------------------------------------------- selection

function mergeRects(rects) {
  rects = rects.filter((r) => r[2] - r[0] > 0.001 && r[3] - r[1] > 0.001).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out = [];
  for (const r of rects) {
    const last = out[out.length - 1];
    if (last) {
      const overlap = Math.min(last[3], r[3]) - Math.max(last[1], r[1]);
      const minH = Math.min(last[3] - last[1], r[3] - r[1]);
      if (overlap > minH * 0.5 && r[0] - last[2] < 0.02) {
        last[0] = Math.min(last[0], r[0]); last[1] = Math.min(last[1], r[1]);
        last[2] = Math.max(last[2], r[2]); last[3] = Math.max(last[3], r[3]);
        continue;
      }
    }
    out.push([...r]);
  }
  return out;
}

function unionBox(rects) {
  return [Math.min(...rects.map((r) => r[0])), Math.min(...rects.map((r) => r[1])),
    Math.max(...rects.map((r) => r[2])), Math.max(...rects.map((r) => r[3]))];
}

function onTextSelection(e) {
  const sel = window.getSelection();
  const down = state.downAt;
  const isClick = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4;
  if (!sel || sel.isCollapsed || !sel.toString().trim()) {
    // A plain click on a highlight opens its thread.
    const pageDiv = e.target.closest(".page");
    if (isClick && pageDiv) {
      const pr = pageDiv.getBoundingClientRect();
      const hit = markAt(Number(pageDiv.dataset.page), (e.clientX - pr.left) / pr.width, (e.clientY - pr.top) / pr.height);
      if (hit?.thread) activateThread(hit.thread.id, { scrollPanel: true });
      else if (hit?.note) openNote(hit.note.id);
    }
    return;
  }
  const text = sel.toString().trim();
  const node = sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
  const pageDiv = node?.closest(".page");
  if (!pageDiv) return;
  const pr = pageDiv.getBoundingClientRect();
  const rects = [...sel.getRangeAt(0).getClientRects()]
    .filter((r) => r.bottom > pr.top && r.top < pr.bottom && r.right > pr.left && r.left < pr.right)
    .map((r) => [(r.left - pr.left) / pr.width, (r.top - pr.top) / pr.height, (r.right - pr.left) / pr.width, (r.bottom - pr.top) / pr.height]
      .map((v) => Math.max(0, Math.min(1, v))));
  const merged = mergeRects(rects);
  if (!merged.length) return;
  state.pending = { kind: "text", page: Number(pageDiv.dataset.page), text, rects: merged, bbox: unionBox(merged) };
  showPending(state.pending);
  showPopup(e.clientX, e.clientY);
}

let rubber = null;
function startRegion(e, pageDiv) {
  e.preventDefault();
  window.getSelection()?.removeAllRanges();
  hidePopup();
  const pr = pageDiv.getBoundingClientRect();
  const x0 = (e.clientX - pr.left) / pr.width, y0 = (e.clientY - pr.top) / pr.height;
  const box = h("div", { class: "rubber" });
  pageDiv.append(box);
  rubber = { pageDiv, x0, y0, box, bbox: null };
  const move = (ev) => {
    const x = Math.max(0, Math.min(1, (ev.clientX - pr.left) / pr.width));
    const y = Math.max(0, Math.min(1, (ev.clientY - pr.top) / pr.height));
    const b = [Math.min(x0, x), Math.min(y0, y), Math.max(x0, x), Math.max(y0, y)];
    rubber.bbox = b;
    box.setAttribute("style", pct(b));
  };
  const up = (ev) => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    box.remove();
    const b = rubber.bbox;
    rubber = null;
    if (!b || (b[2] - b[0]) * pr.width < 8 || (b[3] - b[1]) * pr.height < 8) return;
    setRegionMode(false);
    state.pending = { kind: "region", page: Number(pageDiv.dataset.page), bbox: b, rects: [b] };
    showPending(state.pending);
    showPopup(ev.clientX, ev.clientY);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

function setRegionMode(on) {
  state.regionMode = on && !!state.paper;
  $("#viewer").classList.toggle("region-mode", state.regionMode);
  $("#region-btn").classList.toggle("on", state.regionMode);
  $("#region-hint").hidden = !state.regionMode;
}

async function captureRegion(pageIdx, bbox) {
  const pv = state.pages[pageIdx];
  const pad = [0.008, 0.006];
  const b = [Math.max(0, bbox[0] - pad[0]), Math.max(0, bbox[1] - pad[1]), Math.min(1, bbox[2] + pad[0]), Math.min(1, bbox[3] + pad[1])];
  const wPts = (b[2] - b[0]) * pv.base.width;
  const hPts = (b[3] - b[1]) * pv.base.height;
  let scale = Math.max(1.5, Math.min(4, 1400 / wPts));
  scale = Math.min(scale, 2400 / hPts);
  const vp = pv.page.getViewport({ scale });
  const canvas = h("canvas");
  canvas.width = Math.ceil(wPts * scale);
  canvas.height = Math.ceil(hPts * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await pv.page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -b[0] * vp.width, -b[1] * vp.height] }).promise;
  return canvas.toDataURL("image/png");
}

// The popup lives inside the scrolling viewer, so it stays next to the selection when you scroll.
function showPopup(x, y) {
  const pop = $("#sel-pop");
  const viewer = $("#viewer");
  const sel = state.pending;
  $("#pop-what").textContent = `${sel.kind === "region" ? "框选区域" : `选中 ${sel.text.length} 字`} · p.${sel.page + 1}`;
  // Where to ask: a new thread, or the open one.
  const active = state.threads.find((t) => t.id === state.activeThread);
  const target = $("#pop-target");
  target.innerHTML = "";
  state.popTarget = "new";
  if (active && !(active.id in state.streaming)) {
    const btns = [["new", "新对话"], ["thread", `接着 #${threadNo(active)} 问`]].map(([k, label]) =>
      h("button", { type: "button", class: k === "new" ? "on" : "", onmousedown: (e) => e.preventDefault(),
        onclick: () => { state.popTarget = k; $$("button", target).forEach((b) => b.classList.toggle("on", b === btns[k === "new" ? 0 : 1])); $("input", pop).focus(); } }, label));
    target.append(...btns);
  }
  pop.hidden = false;
  const vr = viewer.getBoundingClientRect();
  const w = pop.offsetWidth, hh = pop.offsetHeight;
  let left = x - vr.left + viewer.scrollLeft - 20;
  left = Math.max(viewer.scrollLeft + 8, Math.min(left, viewer.scrollLeft + viewer.clientWidth - w - 8));
  let top = y - vr.top + viewer.scrollTop + 16;
  if (y + 16 + hh > vr.bottom - 8) top = y - vr.top + viewer.scrollTop - hh - 16;
  pop.style.left = left + "px";
  pop.style.top = top + "px";
  const input = $("input", pop);
  input.value = "";
  setTimeout(() => input.focus({ preventScroll: true }), 0);
}

function hidePopup() {
  const pop = $("#sel-pop");
  pop.hidden = true;
  pop.classList.remove("noting");
  showPending(null);
}

const COLORS = ["yellow", "green", "blue", "pink"];

function startNoteEditor() {
  const pop = $("#sel-pop");
  pop.classList.add("noting");
  const ed = $("#note-editor");
  ed.innerHTML = "";
  let color = localStorage.getItem("pr.noteColor") || "yellow";
  const ta = h("textarea", { rows: 3, placeholder: "写下你的理解或疑问…（可以留空，只划线）。⌘/Ctrl+Enter 保存" });
  const dots = h("div", { class: "colors" }, COLORS.map((c) => h("button", {
    type: "button", class: `dot c-${c} ${c === color ? "on" : ""}`, title: c, onmousedown: (e) => e.preventDefault(),
    onclick: (e) => { color = c; $$(".dot", dots).forEach((d) => d.classList.toggle("on", d === e.currentTarget)); ta.focus(); },
  })));
  const save = async () => {
    localStorage.setItem("pr.noteColor", color);
    await saveAnnotation(ta.value.trim(), color);
  };
  ta.addEventListener("keydown", (e) => {
    if (composing(e)) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
    if (e.key === "Escape") { e.stopPropagation(); hidePopup(); state.pending = null; }
  });
  ed.append(ta, h("div", { class: "note-actions" }, dots,
    h("button", { type: "button", onclick: () => { hidePopup(); state.pending = null; } }, "取消"),
    h("button", { type: "button", class: "primary", onclick: save }, "保存")));
  setTimeout(() => ta.focus(), 0);
}

async function saveAnnotation(note, color) {
  const sel = state.pending;
  if (!sel) return hidePopup();
  const pid = state.paper.id;
  const body = { kind: sel.kind, page: sel.page, bbox: sel.bbox, rects: sel.rects, text: sel.text || "", note, color };
  if (sel.kind === "region") {
    try { body.image = await captureRegion(sel.page, sel.bbox); } catch (e) { console.error(e); }
  }
  let a;
  try {
    a = await api(`/api/papers/${pid}/annotations`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    toast(`没保存成功：${e.message}（内容还在框里）`); // the popup stays open with the text
    return;
  }
  hidePopup();
  state.pending = null;
  window.getSelection()?.removeAllRanges();
  if (state.paper?.id !== pid) return;
  state.memory.annotations = [...(state.memory.annotations || []), a];
  renderHighlights();
  renderMine();
  toast(note ? "已记到笔记里（模型回答时也会看到）" : "已划线");
}

async function askSelection(action, question = "") {
  const sel = state.pending;
  const toThread = state.popTarget === "thread" ? state.activeThread : null;
  hidePopup();
  if (!sel) return;
  state.pending = null;
  window.getSelection()?.removeAllRanges();
  const payload = { kind: sel.kind, page: sel.page, bbox: sel.bbox, rects: sel.rects, text: sel.text || "" };
  const tall = sel.bbox[3] - sel.bbox[1];
  if (sel.kind === "region" || (state.settings.attach_image_for_text && tall < 0.6)) {
    try { payload.image = await captureRegion(sel.page, sel.bbox); } catch (e) { console.error(e); }
  }
  ask({ thread_id: toThread, selection: payload, action, question });
}

// --------------------------------------------------------------------------- ask / threads

async function ask({ thread_id, selection, action = "", question = "" }) {
  const pid = state.paper.id;
  switchTab("qa");
  let tid = thread_id;
  const ctrl = new AbortController();
  if (tid) {
    const t = state.threads.find((x) => x.id === tid);
    const preview = selection ? { ...selection, preview: selection.image, image: undefined } : undefined;
    t.messages.push({ role: "user", display: question || ACTION_LABEL[action] || "", action, selection: preview });
    state.streaming[tid] = "";
    state.aborts[tid] = ctrl;
    state.activeThread = tid;
    renderThreads();
    renderHighlights();
  }
  try {
    const resp = await fetch(`/api/papers/${pid}/ask`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: ctrl.signal,
      body: JSON.stringify({ thread_id, selection, action, question }),
    });
    // Events keep updating the answer even while another paper is open; only the DOM work
    // waits until this paper is on screen again.
    const here = () => state.paper?.id === pid;
    await readSSE(resp, (ev) => {
      if (ev.type === "thread") {
        tid = ev.thread.id;
        state.live[tid] = { pid, thread: ev.thread, mode: ev.mode };
        state.streaming[tid] = "";
        state.streamTools[tid] = [];
        state.aborts[tid] = ctrl;
        if (!here()) return;
        const i = state.threads.findIndex((x) => x.id === tid);
        if (i >= 0) state.threads[i] = ev.thread; else state.threads.push(ev.thread);
        state.activeThread = tid;
        renderThreads();
        renderHighlights();
        $(`.thread[data-id="${tid}"]`)?.scrollIntoView({ block: "nearest" });
      } else if (ev.type === "tool") {
        (state.streamTools[tid] ||= []).push(ev.label);
        const box = here() && $(`.thread[data-id="${tid}"] .tool-log.live`);
        if (box) box.replaceWith(toolLog(state.streamTools[tid], true));
      } else if (ev.type === "delta") {
        state.streaming[tid] += ev.text;
        const el = here() && $(`.thread[data-id="${tid}"] .streaming`);
        // Links are added once the answer is complete, so they stay clickable.
        if (el) renderLater(el, () => followStream(el, () => (el.innerHTML = renderMD(state.streaming[tid] ?? ""))));
      } else if (ev.type === "done" || ev.type === "error") {
        finishStream(tid, ev.message || "");
      }
    });
    if (!tid) throw new Error("没有收到回答");
    if (tid in state.streaming) finishStream(tid, "连接中断了，回答可能不完整");
  } catch (e) {
    if (e.name === "AbortError") {
      finishStream(tid, "", "（已停止）");
    } else {
      toast(`出错了：${e.message}`);
      if (!tid && !thread_id && !selection && !$("#global-ask textarea").value) {
        $("#global-ask textarea").value = question; // give the question back
      }
      finishStream(tid, e.message);
    }
  }
}

// Answers still streaming for a paper that was switched away from and back to.
function mergeLiveThreads(pid, threads) {
  const out = [...threads];
  for (const [tid, live] of Object.entries(state.live)) {
    if (live.pid !== pid || !(tid in state.streaming)) continue;
    const i = out.findIndex((t) => t.id === tid);
    if (i >= 0) out[i] = live.thread; else out.push(live.thread);
  }
  return out;
}

function finishStream(tid, error, suffix = "") {
  if (!tid || !(tid in state.streaming)) return;
  const live = state.live[tid];
  const msg = { role: "assistant", content: state.streaming[tid] + (suffix ? `\n\n${suffix}` : ""), error,
    backend: state.settings.backend, model: state.settings.backends[state.settings.backend]?.model || "",
    mode: live?.mode, tools: state.streamTools[tid] || [] };
  live?.thread.messages.push(msg); // the same object is in state.threads when this paper is open
  delete state.streaming[tid];
  delete state.streamTools[tid];
  delete state.aborts[tid];
  delete state.live[tid];
  // Re-render only this thread, so a follow-up being typed elsewhere is left alone.
  const el = $(`.thread[data-id="${tid}"]`);
  const t = state.threads.find((x) => x.id === tid);
  if (el && t) el.replaceWith(threadEl(t));
}

// Keep the end of a streaming answer in view, unless the reader scrolled away from it.
function followStream(el, update) {
  const panel = $("#tab-qa");
  const pr = panel.getBoundingClientRect();
  const before = el.getBoundingClientRect().bottom;
  const following = before <= pr.bottom + 30 && before >= pr.top;
  update();
  if (following) {
    const after = el.getBoundingClientRect().bottom;
    if (after > pr.bottom - 60) panel.scrollTop += after - pr.bottom + 60;
  }
}

function threadSummary(t) {
  const s = t.selection;
  const first = t.messages[0] || {};
  const act = first.display || ACTION_LABEL[first.action] || "";
  if (!s) return act || "全文提问";
  const what = s.kind === "region" ? "[框选区域]" : `“${(s.text || "").replace(/\s+/g, " ").slice(0, 40)}”`;
  return `${act ? act + " · " : ""}${what}`;
}

function renderThreads() {
  const box = $("#threads");
  box.innerHTML = "";
  $("#qa-count").textContent = state.threads.length ? `(${state.threads.length})` : "";
  if (!state.paper) return;
  if (!state.threads.length) {
    box.append(h("div", { class: "empty-note" }, "在左边的论文里选中文字，或按 R 框选公式/图表，就可以提问。"));
    return;
  }
  for (const t of [...state.threads].reverse()) box.append(threadEl(t));
}

function quoteEl(s) {
  const q = h("div", { class: "quote", title: "在论文里定位", onclick: () => scrollToSelection(s) });
  const src = s.preview || (s.image ? `/api/papers/${state.paper.id}/crops/${s.image}` : null);
  if (s.kind === "region" && src) q.append(h("img", { src, alt: "选区截图" }));
  else q.append(s.text || "");
  return q;
}

function threadEl(t) {
  const open = t.id === state.activeThread;
  const s = t.selection;
  const head = h("div", { class: "th-head", onclick: () => activateThread(open ? null : t.id, { scrollPdf: true }) },
    h("span", { class: "no" }, `#${threadNo(t)}`),
    h("span", { class: "pg" }, s ? `p.${s.page + 1}` : "全文"),
    h("span", { class: "sum" }, threadSummary(t)),
    t.id in state.streaming ? h("span", { class: "live-dot", title: "正在回答" }) : null,
    h("button", {
      class: "x", title: "删除这条问答",
      onclick: async (e) => {
        e.stopPropagation();
        if (!confirm(`删除 #${threadNo(t)} 这条问答？`)) return;
        state.aborts[t.id]?.abort();
        await api(`/api/papers/${state.paper.id}/threads/${t.id}`, { method: "DELETE" });
        state.threads = state.threads.filter((x) => x.id !== t.id);
        if (state.activeThread === t.id) state.activeThread = null;
        renderThreads(); renderHighlights();
      },
    }, "✕"));
  const body = h("div", { class: "th-body" });
  if (s) body.append(quoteEl(s));
  t.messages.forEach((m, i) => {
    if (m.role === "user") {
      if (i > 0 && m.selection) body.append(quoteEl(m.selection));
      const label = m.display || ACTION_LABEL[m.action] || "";
      if (label) body.append(h("div", { class: "msg-user" }, h("span", {}, label)));
    } else {
      if (m.tools?.length) body.append(toolLog(m.tools, false));
      const md = h("div", { class: "md" });
      mdInto(md, m.content || "");
      body.append(md);
      if (m.error) body.append(h("div", { class: "msg-err" }, m.error));
      const who = m.backend ? (BACKEND_INFO[m.backend]?.[0] || m.backend) + (m.model ? ` (${m.model})` : "") + ` · ${m.mode === "full" ? "全文模式" : "记忆模式"}` : "";
      const copy = h("button", {
        class: "copy", title: "复制这段回答",
        onclick: async () => { await navigator.clipboard.writeText(m.content || ""); copy.textContent = "已复制"; setTimeout(() => (copy.textContent = "复制"), 1200); },
      }, "复制");
      const clip = h("button", {
        class: "copy", title: "把这段回答摘到「笔记」页",
        onclick: () => {
          const q = t.messages[i - 1]?.display || threadSummary(t);
          appendMyNotes(`> 摘自问答 #${threadNo(t)}（${s ? `p.${s.page + 1}` : "全文"}）：${q}\n\n${m.content || ""}`);
        },
      }, "摘到笔记");
      body.append(h("div", { class: "msg-meta" }, h("span", {}, copy, clip), h("span", {}, who)));
    }
  });
  if (t.id in state.streaming) {
    body.append(toolLog(state.streamTools[t.id] || [], true));
    const md = h("div", { class: "md streaming typing" });
    mdInto(md, state.streaming[t.id]);
    body.append(md);
    body.append(h("div", { class: "followup" },
      h("button", { class: "stop", onclick: () => state.aborts[t.id]?.abort() }, "■ 停止")));
  } else {
    const ta = h("textarea", { rows: 1, placeholder: "继续追问…（Enter 发送）。也可以在论文里再选一段，选「接着问」" });
    ta.value = state.drafts[t.id] || "";
    if (ta.value) setTimeout(() => autoGrow(ta), 0);
    ta.addEventListener("input", () => { state.drafts[t.id] = ta.value; autoGrow(ta); });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !composing(e)) {
        e.preventDefault();
        const q = ta.value.trim();
        if (q) { delete state.drafts[t.id]; ask({ thread_id: t.id, question: q }); }
      }
    });
    body.append(h("div", { class: "followup" }, ta));
  }
  return h("div", { class: `thread ${open ? "open active" : ""}`, "data-id": t.id }, head, body);
}

function toolLog(labels, live) {
  const box = h("div", { class: "tool-log" + (live ? " live" : "") });
  for (const l of labels) {
    const m = l.match(/第 (\d+)/);
    box.append(h("div", {
      class: "tool-call" + (m ? " link" : ""), title: m ? "跳到这一页" : "",
      onclick: m ? () => jumpToPage(Number(m[1]) - 1) : null,
    }, (l.startsWith("搜索") ? "🔍 " : l.startsWith("阅读") ? "📖 " : "🖼 ") + l));
  }
  if (!labels.length) box.hidden = true;
  return box;
}

function activateThread(id, { scrollPdf = false, scrollPanel = false } = {}) {
  state.activeThread = id;
  switchTab("qa");
  renderThreads();
  renderHighlights();
  const t = state.threads.find((x) => x.id === id);
  if (t && scrollPdf && t.selection) scrollToSelection(t.selection);
  if (t && scrollPanel) $(`.thread[data-id="${id}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
}

// --------------------------------------------------------------------------- memory / first read

const fmtTime = (t) => new Date(t * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const sourceText = (src) => !src ? "" : [
  src.backend ? `${BACKEND_INFO[src.backend]?.[0] || src.backend}${src.model ? ` (${src.model})` : ""}` : "",
  src.time ? fmtTime(src.time) : "",
].filter(Boolean).join(" · ");

function renderMemoryBar() {
  const bar = $("#notes-bar");
  bar.innerHTML = "";
  const st = state.digestStatus;
  $("#notes-status").textContent = st === "running" ? "⏳" : st === "error" ? "⚠" : "";
  if (!state.paper) return;
  const all = h("button", { class: st === "none" ? "primary" : "", onclick: () => startDigest("all") }, st === "none" ? "让 AI 通读全文" : "重新通读");
  const figs = h("button", { onclick: () => startDigest("figures") }, "重新看图表");
  if (st === "running") bar.append(h("span", { class: "typing" }, state.digestPhase || "正在通读…"));
  else if (st === "none") bar.append(h("span", {}, "还没有通读。通读后，笔记和图表描述会存成这篇论文的记忆，之后换哪个模型提问都直接用它，不用重读。"), all);
  else if (st === "error") bar.append(h("span", { class: "warn" }, `通读失败：${state.digestError || ""}`), all);
  else {
    // Say plainly that a memory written by one model is used as-is by the one selected now.
    const author = state.memory.info?.notes?.backend;
    const now = state.settings.backend;
    const note = author && author !== now
      ? `这份记忆是 ${BACKEND_INFO[author]?.[0] || author} 写的；现在用 ${BACKEND_INFO[now]?.[0] || now} 提问也直接用它，不用重读。`
      : "这篇论文的记忆存在本地，所有模型共用。";
    bar.append(h("span", {}, note), all, figs);
  }
}

function renderMemory() {
  renderMemoryBar();
  const box = $("#memory");
  box.innerHTML = "";
  if (!state.paper) return;
  const mem = state.memory;
  const info = mem.info || {};
  const section = (title, sub, open, ...kids) =>
    h("details", { class: "mem-sec", open }, h("summary", {}, h("b", {}, title), sub ? h("span", { class: "mem-src" }, sub) : null), ...kids);

  const notesSub = [sourceText(info.notes), info.notes?.edited ? "已人工修改" : ""].filter(Boolean).join(" · ");
  box.append(section("通读笔记", notesSub, true, ...aiNotesBody(mem)));

  const figList = h("div", { class: "fig-list" });
  for (const f of mem.figures || []) {
    const desc = h("div", { class: "md" });
    mdInto(desc, f.description || "_（还没有图像描述）_");
    figList.append(h("div", { class: "fig" },
      h("div", { class: "fig-head", title: "跳到这张图", onclick: () => scrollToSelection({ page: f.page - 1, bbox: f.bbox || [0, 0, 1, 0.3] }) },
        h("b", {}, f.label), h("span", { class: "pg" }, `p.${f.page}`)),
      h("div", { class: "fig-cap" }, f.uncaptioned ? (f.caption ? `图下文字：${f.caption}` : "（无图注）") : f.caption || ""), desc));
  }
  if (!(mem.figures || []).length) figList.append(h("div", { class: "hint" }, state.digestStatus === "running" ? "通读完笔记后会看图表…" : "没有记录图表"));
  const figSub = [sourceText(info.figures), info.figures?.note].filter(Boolean).join(" · ");
  box.append(section(`图表（${(mem.figures || []).length}）`, figSub, false, figList));

  const qaList = h("div", { class: "qa-list" });
  for (const q of mem.qa || []) {
    const facts = h("div", { class: "md" });
    mdInto(facts, q.facts || "");
    qaList.append(h("div", { class: "qa" },
      h("div", { class: "fig-head", title: "打开这条问答", onclick: () => activateThread(q.thread_id, { scrollPdf: true, scrollPanel: true }) },
        h("span", { class: "pg" }, q.page ? `p.${q.page}` : "全文"), h("span", { class: "sum" }, q.question || ""),
        h("button", {
          class: "x", title: "从记忆里删掉（问答本身保留）",
          onclick: async (e) => {
            e.stopPropagation();
            await api(`/api/papers/${state.paper.id}/memory/qa/${q.thread_id}`, { method: "DELETE" });
            refreshMemory();
          },
        }, "✕")),
      facts));
  }
  if (!(mem.qa || []).length) qaList.append(h("div", { class: "hint" }, "每次问答结束后，有用的结论会自动提炼到这里，之后的问题都能用上。"));
  box.append(section(`问答沉淀（${(mem.qa || []).length}）`, "", true, qaList));
}

function aiNotesBody(mem) {
  const kids = [];
  if (mem.has_new_notes && state.digestStatus !== "running") {
    const preview = h("div", { class: "md new-notes", hidden: true });
    const resolve = async (accept) => {
      if (accept && !confirm("换成新版笔记？你改过的版本会备份成 notes.edited.*.md 文件。")) return;
      state.memory = await api(`/api/papers/${state.paper.id}/memory/notes/new`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accept }) });
      renderMemory();
    };
    kids.push(h("div", { class: "banner" },
      h("div", {}, "重新通读生成了一份新的 AI 笔记。你改过的版本还在用，没有被覆盖。"),
      h("div", { class: "banner-actions" },
        h("button", { onclick: async () => {
          if (preview.hidden) mdInto(preview, (await api(`/api/papers/${state.paper.id}/memory/notes/new`)).text);
          preview.hidden = !preview.hidden;
        } }, "看新版"),
        h("button", { onclick: () => resolve(true) }, "换成新版"),
        h("button", { onclick: () => resolve(false) }, "丢弃新版")),
      preview));
  }
  const view = h("div", { id: "notes", class: "md" });
  mdInto(view, mem.notes || "");
  const edit = h("button", { class: "edit-btn", title: "改正或补充 AI 的笔记；改过的版本不会被重新通读覆盖" }, "✎ 编辑");
  edit.onclick = () => {
    const ta = h("textarea", { class: "notes-editor" });
    ta.value = mem.notes || "";
    const bar = h("div", { class: "editor-actions" },
      h("span", { class: "hint" }, "Markdown，公式用 $…$"),
      h("button", { onclick: () => renderMemory() }, "取消"),
      h("button", { class: "primary", onclick: async () => {
        state.memory = await api(`/api/papers/${state.paper.id}/memory/notes`, {
          method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: ta.value }) });
        renderMemory();
        toast("通读笔记已保存，之后的回答都会用你改过的版本");
      } }, "保存"));
    view.replaceWith(ta);
    edit.replaceWith(bar);
    ta.style.height = Math.max(300, Math.min(ta.scrollHeight + 10, window.innerHeight * 0.7)) + "px";
    ta.focus();
  };
  if (state.digestStatus !== "running" && mem.notes) kids.push(h("div", { class: "edit-row" }, edit));
  kids.push(view);
  return kids;
}

async function refreshMemory() {
  if (!state.paper) return;
  const pid = state.paper.id;
  await flushMyNotes(); // so the server copy has the latest notes
  const mem = await api(`/api/papers/${pid}/memory`);
  if (state.paper?.id !== pid) return;
  if (pendingNotes) mem.my_notes = state.memory.my_notes; // typed while we were fetching
  state.memory = mem;
  // Leave open editors alone.
  if (state.digestStatus !== "running" && !$("#memory .notes-editor")) renderMemory();
  if (!$("#mine .note-card textarea")) renderMine();
  renderHighlights();
}

async function startDigest(parts) {
  const pid = state.paper.id;
  if (parts === "all" && state.memory.notes && !confirm("重新通读会覆盖现在的笔记和图表描述（问答沉淀会保留），继续？")) return;
  await api(`/api/papers/${pid}/digest?parts=${parts}`, { method: "POST" });
  state.digestStatus = "running";
  state.digestPhase = "";
  if (parts === "all") state.memory.notes = "";
  renderMemory();
  switchTab("notes");
  followDigest(pid);
}

const digestFollowers = {}; // pid -> AbortController

async function followDigest(pid) {
  digestFollowers[pid]?.abort(); // the server replays from the start, so one follower is enough
  const ctrl = (digestFollowers[pid] = new AbortController());
  let finished = false;
  try {
    const resp = await fetch(`/api/papers/${pid}/digest/stream`, { signal: ctrl.signal });
    let text = "";
    await readSSE(resp, (ev) => {
      if (ev.type === "reset") text = "";
      if (ev.type === "delta") text += ev.text;
      if (ev.type === "done" || ev.type === "error") finished = true;
      if (state.paper?.id !== pid) return;
      if (ev.type === "delta") {
        state.memory.notes = text;
        const el = $("#notes");
        if (el) renderLater(el, () => (el.innerHTML = renderMD(state.memory.notes)));
      }
      if (ev.type === "phase") {
        state.digestPhase = ev.text;
        renderMemoryBar();
        if (ev.text.startsWith("正在看图表")) refreshMemory();
      }
      if (ev.type === "done" || ev.type === "error") {
        state.digestStatus = ev.type;
        state.digestError = ev.message;
        refreshMemory().then(renderMemory);
        loadAnchors(pid);
        loadLibrary();
        if (ev.type === "done") toast("通读完成，记忆在「记忆」里");
      }
    });
  } catch (e) {
    if (e.name === "AbortError") return;
    console.error(e);
  }
  if (finished || ctrl.signal.aborted) return;
  // The stream dropped (sleep, server restart): look at the job again.
  setTimeout(async () => {
    if (state.paper?.id !== pid || digestFollowers[pid] !== ctrl) return;
    try {
      const r = await api(`/api/papers/${pid}`);
      state.digestStatus = r.digest_status;
      if (r.digest_status === "running") followDigest(pid);
      else refreshMemory().then(renderMemory);
    } catch { state.digestStatus = "error"; state.digestError = "和后台的连接断了"; renderMemoryBar(); }
  }, 2000);
}

function switchTab(name) {
  if (name === "notes" && state.paper && !$("#tab-notes").classList.contains("active")) refreshMemory();
  if (name === "mine" && state.paper && !$("#mine .note-card textarea")) renderMine();
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
}

// --------------------------------------------------------------------------- the reader's own notes
// 笔记 tab: free-form notes (autosaved) and every highlight / margin note, in page order.
// Both are part of the paper's memory, so every model sees them.

// Pending autosave of 我的笔记: remembers which paper and what text, and is flushed before
// anything replaces state.memory (switching paper, refreshing memory, closing the page).
let pendingNotes = null; // {pid, text, timer}

function queueMyNotes(text, status) {
  clearTimeout(pendingNotes?.timer);
  const job = { pid: state.paper.id, text };
  job.timer = setTimeout(() => flushMyNotes().then(() => status && (status.textContent = "已保存")), 600);
  pendingNotes = job;
}

async function flushMyNotes() {
  const job = pendingNotes;
  if (!job) return;
  pendingNotes = null;
  clearTimeout(job.timer);
  try {
    await api(`/api/papers/${job.pid}/my-notes`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: job.text }) });
  } catch (e) {
    toast(`笔记没保存成功：${e.message}`);
  }
}

window.addEventListener("beforeunload", () => {
  if (!pendingNotes) return;
  fetch(`/api/papers/${pendingNotes.pid}/my-notes`, {
    method: "PUT", keepalive: true, headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: pendingNotes.text }) });
});

function renderMine() {
  const box = $("#mine");
  if (!box) return;
  box.innerHTML = "";
  $("#mine-count").textContent = (state.memory.annotations || []).length ? `(${state.memory.annotations.length})` : "";
  if (!state.paper) return;
  const text = state.memory.my_notes || "";
  if (state.mineEditing === undefined) state.mineEditing = !text.trim();

  // Free-form notes
  const status = h("span", { class: "hint save-status" });
  const toggle = h("button", { onclick: () => { state.mineEditing = !state.mineEditing; renderMine(); } }, state.mineEditing ? "预览" : "✎ 编辑");
  let body;
  if (state.mineEditing) {
    body = h("textarea", { class: "notes-editor mine-editor", placeholder: "在这里记下你的理解、疑问、待查的点…\n支持 Markdown 和 $公式$；写 Figure 3、Eq. (2)、[p.5]、[17] 之后预览里可以点击跳转。\n问答里的回答可以点「摘到笔记」放进来。" });
    body.value = text;
    body.addEventListener("input", () => {
      state.memory.my_notes = body.value;
      status.textContent = "保存中…";
      queueMyNotes(body.value, status);
    });
    setTimeout(() => { body.style.height = Math.max(180, Math.min(body.scrollHeight + 10, window.innerHeight * 0.55)) + "px"; }, 0);
  } else {
    body = h("div", { class: "md mine-view", title: "双击编辑", ondblclick: () => { state.mineEditing = true; renderMine(); } });
    mdInto(body, text || "_还没有笔记。_");
  }
  box.append(h("section", { class: "mine-sec" },
    h("div", { class: "mine-head" }, h("b", {}, "我的笔记"), status, toggle), body));

  // Highlights and margin notes
  const list = h("div", { class: "note-list" });
  const items = [...(state.memory.annotations || [])].sort((a, b) => a.page - b.page || a.bbox[1] - b.bbox[1]);
  for (const a of items) list.append(noteCard(a));
  if (!items.length) list.append(h("div", { class: "hint" }, "在论文里选中文字或框选一块，点弹窗里的「✎ 记笔记」，批注会出现在这里和页边。"));
  box.append(h("section", { class: "mine-sec" }, h("div", { class: "mine-head" }, h("b", {}, `批注（${items.length}）`)), list));
}

function noteCard(a) {
  const card = h("div", { class: `note-card c-${a.color} ${a.id === state.activeNote ? "active" : ""}`, "data-id": a.id });
  const jump = () => { state.activeNote = a.id; renderHighlights(); jumpTo({ kind: "note", page: a.page + 1, bbox: a.bbox }); };
  const colorDots = h("span", { class: "colors small" }, COLORS.map((c) => h("button", {
    class: `dot c-${c} ${c === a.color ? "on" : ""}`, title: "换颜色",
    onclick: () => updateNote(a, { color: c }),
  })));
  const del = h("button", { class: "x", title: "删除这条批注", onclick: async () => {
    if (!confirm("删除这条批注？")) return;
    await api(`/api/papers/${state.paper.id}/annotations/${a.id}`, { method: "DELETE" });
    state.memory.annotations = state.memory.annotations.filter((x) => x.id !== a.id);
    renderMine(); renderHighlights();
  } }, "✕");
  card.append(h("div", { class: "note-head" },
    h("span", { class: "pg", title: "跳到原文", onclick: jump }, `p.${a.page + 1}`), colorDots, del));
  const quote = h("div", { class: "quote", title: "跳到原文", onclick: jump });
  if (a.kind === "region" && a.image) quote.append(h("img", { src: `/api/papers/${state.paper.id}/crops/${a.image}`, alt: "框选区域" }));
  else quote.append(a.text || "");
  card.append(quote);
  const noteView = h("div", { class: "md note-body", title: "双击编辑" });
  mdInto(noteView, a.note || "_（只划线，没有写批注。双击添加）_");
  noteView.ondblclick = () => {
    const ta = h("textarea", { class: "notes-editor", rows: 3 });
    ta.value = a.note || "";
    const save = () => updateNote(a, { note: ta.value.trim() });
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } });
    noteView.replaceWith(ta, h("div", { class: "editor-actions" },
      h("button", { onclick: () => renderMine() }, "取消"), h("button", { class: "primary", onclick: save }, "保存")));
    ta.focus();
  };
  card.append(noteView);
  return card;
}

async function updateNote(a, patch) {
  let upd;
  try {
    upd = await api(`/api/papers/${state.paper.id}/annotations/${a.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  } catch (e) {
    return toast(`没保存成功：${e.message}`);
  }
  state.memory.annotations = state.memory.annotations.map((x) => (x.id === a.id ? upd : x));
  renderMine(); renderHighlights();
}

function openNote(id) {
  state.activeNote = id;
  switchTab("mine");
  renderMine();
  renderHighlights();
  $(`.note-card[data-id="${id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
}

async function saveMyNotes() {
  queueMyNotes(state.memory.my_notes || "");
  await flushMyNotes();
}

async function appendMyNotes(md) {
  const cur = (state.memory.my_notes || "").trimEnd();
  state.memory.my_notes = (cur ? cur + "\n\n" : "") + md.trim() + "\n";
  await saveMyNotes();
  state.mineEditing = false;
  renderMine();
  toast("已摘到「笔记」页");
}

// --------------------------------------------------------------------------- links into the paper
// "Figure 3", "Eq. (2)", "§3.2", "[17]", "[p.5]" in answers and notes become links: hover shows a
// preview of that spot, click jumps there (and ↩ brings you back). The PDF's own internal links
// (citations, figure references) get the same preview.

function mdInto(el, src) {
  el.innerHTML = renderMD(src);
  linkify(el);
}

async function loadAnchors(pid) {
  try {
    const a = await api(`/api/papers/${pid}/anchors`);
    if (state.paper?.id !== pid) return;
    state.anchors = a;
    // Re-link what is already on screen.
    $$("#threads .md:not(.streaming), #memory .md, #mine .md").forEach(linkify);
  } catch (e) { console.error(e); }
}

const REF_RE = new RegExp([
  String.raw`\[p\.\s*(\d{1,3})(?:\s*[-–]\s*\d{1,3})?[^\]\n]{0,40}\]`,                       // 1 [p.4 ...]
  String.raw`\b(?:Figure|Fig\.)\s*(\d{1,2})\b|图\s*(\d{1,2})(?![\d.])`,                      // 2,3
  String.raw`\b(?:Table|Tab\.)\s*(\d{1,2})\b|(?<![代列图发外报统])表\s*(\d{1,2})(?![\d.])`,   // 4,5
  String.raw`\b(?:Eqs?\.|Equations?)\s*\(?(\d{1,3}[a-z]?)\)?|(?:公式|式)\s*\(\s*(\d{1,3}[a-z]?)\s*\)`, // 6,7
  String.raw`§\s*(\d{1,2}(?:\.\d{1,2})*)|\bSection\s+(\d{1,2}(?:\.\d{1,2})*)|第\s*(\d{1,2}(?:\.\d{1,2})*)\s*节`, // 8,9,10
  String.raw`\[(\d{1,3}(?:\s*[,，]\s*\d{1,3})*)\](?!\()`,                                     // 11 citations
  String.raw`\bp\.\s?(\d{1,3})\b|第\s*(\d{1,3})\s*页`,                                       // 12,13
  String.raw`[“"]([^”"\n]{6,400})[”"]\s*\[p\.\s*(\d{1,3})[^\]\n]{0,40}\]`,                     // 14,15 “quote” [p.N]
].join("|"), "g");

function anchorFor(m) {
  const A = state.anchors || {};
  const n = state.paper?.num_pages || state.pages.length;
  const page = (p) => (p >= 1 && p <= n ? { kind: "page", label: `第 ${p} 页`, page: p, bbox: [0, 0, 1, 1] } : null);
  const fig = (label) => A.figures?.[label] && { kind: "figure", label, ...A.figures[label] };
  if (m[1]) return page(+m[1]);
  if (m[2] || m[3]) return fig(`Figure ${m[2] || m[3]}`);
  if (m[4] || m[5]) return fig(`Table ${m[4] || m[5]}`);
  if (m[6] || m[7]) { const k = m[6] || m[7]; return A.equations?.[k] && { kind: "equation", label: `Eq. (${k})`, ...A.equations[k] }; }
  if (m[8] || m[9] || m[10]) { const k = m[8] || m[9] || m[10]; const s = A.sections?.[k]; return s && { kind: "section", label: `§${k} ${s.title}`, ...s }; }
  if (m[12] || m[13]) return page(+(m[12] || m[13]));
  return null;
}

function refLink(text, target) {
  const a = h("a", { class: `ref ref-${target.kind}`, href: "#" }, text);
  a._target = target;
  return a;
}

function linkify(root) {
  if (!root || !state.paper) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => n.parentElement.closest(".katex, code, pre, a") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    REF_RE.lastIndex = 0;
    let m, last = 0;
    const frag = document.createDocumentFragment();
    while ((m = REF_RE.exec(text))) {
      let pieces = null;
      if (m[14]) {
        pieces = [refLink(m[0], { kind: "quote", label: "原文引用", page: +m[15], quote: m[14], bbox: [0, 0, 1, 0.2] })];
      } else if (m[11]) {
        // [3, 17]: one link per reference number that exists
        const refs = state.anchors?.references || {};
        const nums = m[11].split(/\s*[,，]\s*/);
        if (!nums.some((k) => refs[k])) continue;
        pieces = ["["];
        nums.forEach((k, i) => {
          if (i) pieces.push(", ");
          pieces.push(refs[k] ? refLink(k, { kind: "reference", label: `[${k}]`, ...refs[k] }) : k);
        });
        pieces.push("]");
      } else {
        const t = anchorFor(m);
        if (!t) continue;
        pieces = [refLink(m[0], t)];
      }
      frag.append(text.slice(last, m.index), ...pieces);
      last = m.index + m[0].length;
    }
    if (last === 0) continue;
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
  verifyQuotes(root);
}

// Quotes are checked against the PDF: found → ✓ and a click highlights the exact words;
// not found → ⚠ (the model paraphrased or misremembered).
const quoteCache = new Map();

async function verifyQuotes(root) {
  const links = $$("a.ref-quote:not([data-checked])", root);
  if (!links.length || !state.paper) return;
  const todo = [];
  for (const a of links) {
    a.dataset.checked = "1";
    const t = a._target, key = `${state.paper.id}|${t.page}|${t.quote}`;
    if (quoteCache.has(key)) applyQuote(a, quoteCache.get(key));
    else todo.push({ a, key });
  }
  if (!todo.length) return;
  const uniq = [...new Map(todo.map((x) => [x.key, x])).values()];
  try {
    const res = await api(`/api/papers/${state.paper.id}/locate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: uniq.map((x) => ({ page: x.a._target.page, quote: x.a._target.quote })) }) });
    uniq.forEach((x, i) => quoteCache.set(x.key, res[i]));
    for (const x of todo) applyQuote(x.a, quoteCache.get(x.key));
  } catch (e) { console.error(e); }
}

function applyQuote(a, r) {
  const t = a._target;
  if (r?.verified) {
    a.classList.add("ok");
    t.page = r.page;
    t.rects = r.rects;
    t.spans = r.spans; // a quote across a page break covers two pages
    t.bbox = unionBox(r.rects);
    t.verified = true;
    a.title = "已在原文中核实，点击高亮原句";
  } else {
    a.classList.add("bad");
    t.verified = false;
    a.title = "没在原文里找到这句，可能是模型改写或记错了";
  }
}

// ---- jumping, flashing, going back

function jumpTo(target, { remember = true } = {}) {
  const pv = state.pages[target.page - 1];
  if (!pv) return;
  const viewer = $("#viewer");
  if (remember) {
    state.backStack.push(readingPosition());
    updateBackBtn();
  }
  const b = target.bbox || [0, 0, 1, 1];
  const y = pv.div.offsetTop + b[1] * pv.div.offsetHeight - (target.kind === "page" ? 10 : viewer.clientHeight * 0.2);
  viewer.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
  if (target.kind === "quote" && target.verified === false) toast("没在原文里找到这句引用，已跳到它标的页");
  else if (target.spans) target.spans.forEach((sp) => state.pages[sp.page - 1] && sp.rects.forEach((r) => flash(state.pages[sp.page - 1], r)));
  else if (target.rects) target.rects.forEach((r) => flash(pv, r));
  else if (target.kind !== "page") flash(pv, b);
}

function flash(pv, b) {
  const el = h("div", { class: "flash", style: pct(b) });
  pv.div.append(el);
  setTimeout(() => el.remove(), 2200);
}

function updateBackBtn() {
  const btn = $("#back-btn");
  btn.hidden = !state.backStack.length;
}

// Positions are kept as (page, fraction of page) so they survive zooming.
function readingPosition() {
  const top = $("#viewer").scrollTop;
  const pv = [...state.pages].reverse().find((p) => p.div.offsetTop <= top) || state.pages[0];
  return pv ? { page: pv.idx, frac: (top - pv.div.offsetTop) / pv.div.offsetHeight } : { page: 0, frac: 0 };
}

function goBack() {
  const pos = state.backStack.pop();
  updateBackBtn();
  const pv = pos && state.pages[pos.page];
  if (pv) $("#viewer").scrollTo({ top: pv.div.offsetTop + pos.frac * pv.div.offsetHeight, behavior: "smooth" });
}

// ---- hover previews

const previewCache = new Map();

async function renderCrop(pageIdx, bbox, maxW = 440) {
  const key = `${state.paper.id}:${pageIdx}:${bbox.map((v) => v.toFixed(3)).join(",")}`;
  if (previewCache.has(key)) return previewCache.get(key);
  const pv = state.pages[pageIdx];
  const b = [Math.max(0, bbox[0]), Math.max(0, bbox[1]), Math.min(1, bbox[2]), Math.min(1, bbox[3])];
  const wPts = (b[2] - b[0]) * pv.base.width, hPts = (b[3] - b[1]) * pv.base.height;
  const scale = Math.min(3, (maxW * (window.devicePixelRatio || 1)) / wPts, 1600 / hPts);
  const vp = pv.page.getViewport({ scale });
  const canvas = h("canvas");
  canvas.width = Math.ceil(wPts * scale);
  canvas.height = Math.ceil(hPts * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await pv.page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -b[0] * vp.width, -b[1] * vp.height] }).promise;
  const url = canvas.toDataURL("image/png");
  previewCache.set(key, url);
  if (previewCache.size > 60) previewCache.delete(previewCache.keys().next().value);
  return url;
}

let previewTimer = null, previewFor = null;

function showPreview(anchorEl, target) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    previewFor = anchorEl;
    const box = $("#ref-preview");
    box.classList.toggle("small", target.kind === "page");
    const title = target.kind === "page"
      ? h("div", { class: "rp-title" }, h("b", {}, `p.${target.page}`), h("span", {}, " 整页"), h("span", { class: "rp-hint" }, "点击跳转"))
      : h("div", { class: "rp-title" }, h("b", {}, target.label), h("span", {}, ` · p.${target.page}`), h("span", { class: "rp-hint" }, "点击跳转"));
    box.replaceChildren(title, h("div", { class: "rp-body hint" }, "…"));
    box.hidden = false;
    placePreview(box, anchorEl);
    let body;
    if (target.kind === "reference" && target.text) {
      body = h("div", { class: "rp-text" }, target.text);
    } else if (target.kind === "quote") {
      const status = h("div", { class: `rp-status ${target.verified ? "ok" : "bad"}` },
        target.verified ? "✓ 已在原文中找到" : target.verified === false ? "⚠ 没在原文里找到这句" : "核对中…");
      if (target.verified) {
        const b = target.bbox;
        const url = await renderCrop(target.page - 1, [0.02, Math.max(0, b[1] - 0.03), 0.98, Math.min(1, b[3] + 0.03)], 440);
        body = h("div", {}, status, h("img", { src: url, alt: "原文" }));
      } else body = status;
    } else {
      const bbox = target.kind === "page" ? [0, 0, 1, 1] : target.bbox;
      const url = await renderCrop(target.page - 1, bbox, target.kind === "page" ? 200 : 440);
      body = h("img", { src: url, alt: target.label });
    }
    if (previewFor !== anchorEl) return;
    box.replaceChildren(title, body);
    placePreview(box, anchorEl);
  }, 450);
}

function placePreview(box, anchorEl) {
  const r = anchorEl.getBoundingClientRect();
  const w = box.offsetWidth, hh = box.offsetHeight;
  let left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + hh > window.innerHeight - 8) top = Math.max(8, r.top - hh - 6);
  box.style.left = left + "px";
  box.style.top = top + "px";
}

function hidePreview() {
  clearTimeout(previewTimer);
  previewFor = null;
  $("#ref-preview").hidden = true;
}

// ---- the PDF's own internal links

async function linkLayer(pv) {
  const layer = h("div", { class: "link-layer" });
  let annots = [];
  try { annots = await pv.page.getAnnotations({ intent: "display" }); } catch { return layer; }
  const W = pv.base.width, H = pv.base.height;
  for (const a of annots) {
    if (a.subtype !== "Link" || (!a.dest && !a.url)) continue;
    const [x0, y0, x1, y1] = pv.base.convertToViewportRectangle(a.rect);
    const r = [Math.min(x0, x1) / W, Math.min(y0, y1) / H, Math.max(x0, x1) / W, Math.max(y0, y1) / H];
    const el = h("a", { class: "pdf-link", href: a.url || "#", style: pct(r) });
    if (a.url) {
      el.target = "_blank";
      el.rel = "noopener";
      el.title = a.url;
    } else {
      el._dest = a.dest;
    }
    layer.append(el);
  }
  return layer;
}

async function resolveDest(dest) {
  const pdf = state.pdf;
  const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
  if (!explicit) return null;
  const pageIdx = typeof explicit[0] === "object" ? await pdf.getPageIndex(explicit[0]) : explicit[0];
  const pv = state.pages[pageIdx];
  if (!pv) return null;
  // XYZ destinations carry the top-left point; others go to the page top.
  let y = 0;
  if (explicit[1]?.name === "XYZ" && explicit[3] != null) y = pv.base.convertToViewportPoint(0, explicit[3])[1] / pv.base.height;
  const name = typeof dest === "string" ? dest : "";
  const A = state.anchors || {};
  // hyperref names: figure.3 / table.2 / equation.1
  const named = name.match(/^(figure|table|equation)\.(\d+)$/);
  if (named) {
    const [, kind, k] = named;
    const hit = kind === "equation" ? A.equations?.[k] : A.figures?.[`${kind === "figure" ? "Figure" : "Table"} ${k}`];
    if (hit) return { kind: kind === "equation" ? "equation" : "figure", page: hit.page, bbox: hit.bbox,
      label: kind === "equation" ? `Eq. (${k})` : `${kind === "figure" ? "Figure" : "Table"} ${k}` };
  }
  // Otherwise use the anchor on that page that starts nearest the destination.
  const kinds = [["references", "reference"], ["figures", "figure"], ["equations", "equation"], ["sections", "section"]];
  let best = null, bestD = 0.06;
  for (const [key, kind] of kinds) {
    for (const [k, v] of Object.entries(A[key] || {})) {
      if (v.page !== pageIdx + 1) continue;
      const d = Math.abs(v.bbox[1] - y); // destinations point at the top of the target
      if (d < bestD) {
        bestD = d;
        best = { kind, page: v.page, bbox: v.bbox, text: v.text,
          label: kind === "reference" ? `[${k}]` : kind === "equation" ? `Eq. (${k})` : kind === "section" ? `§ ${v.title}` : k };
      }
    }
  }
  if (best) return best;
  const label = name.startsWith("cite.") ? "参考文献" : /footnote/i.test(name) ? "脚注" : /section/i.test(name) ? "章节" : "链接";
  return { kind: "dest", label, page: pageIdx + 1, bbox: [0.03, Math.max(0, y - 0.01), 0.97, Math.min(1, y + 0.16)] };
}

function wireLinks() {
  // Links in answers / notes
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a.ref");
    if (a?._target) { e.preventDefault(); hidePreview(); jumpTo(a._target); return; }
    const p = e.target.closest("a.pdf-link");
    if (p && p._dest) {
      e.preventDefault();
      hidePreview();
      resolveDest(p._dest).then((t) => t && jumpTo(t));
    }
  });
  document.addEventListener("mouseover", (e) => {
    const a = e.target.closest("a.ref");
    if (a?._target) return showPreview(a, a._target);
    const p = e.target.closest("a.pdf-link");
    if (p && p._dest) {
      resolveDest(p._dest).then((t) => t && e.target.closest("a.pdf-link") === p && showPreview(p, t));
    }
  });
  document.addEventListener("mouseout", (e) => {
    if (e.target.closest("a.ref, a.pdf-link") && !e.relatedTarget?.closest?.("#ref-preview")) hidePreview();
  });
  $("#back-btn").onclick = goBack;
  // A preview never outlives scrolling (it would point at the wrong place).
  document.addEventListener("scroll", (e) => {
    if (!$("#ref-preview").hidden && !e.target.closest?.("#ref-preview")) hidePreview();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select, [contenteditable]")) return;
    if ((e.altKey && e.key === "ArrowLeft") || e.key === "Backspace") {
      if (state.backStack.length) { e.preventDefault(); goBack(); }
    }
  });
}

// --------------------------------------------------------------------------- wiring

let mm = null; // the derivation map view

function wire() {
  wireLinks();
  mm = initMindmap({ state, api, h, $, toast, renderCrop, jumpTo, ask, readSSE });
  $("#toggle-lib").onclick = () => document.body.classList.toggle("lib-hidden");
  $("#backend-btn").onclick = openSettings;
  $$("#mode-switch button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  $("#file-input").onchange = (e) => { uploadFiles([...e.target.files]); e.target.value = ""; };
  $("#url-form").onsubmit = (e) => { e.preventDefault(); const v = $("#url-input").value.trim(); if (v) { importUrl(v); $("#url-input").value = ""; } };
  $("#zoom-in").onclick = () => setZoom(state.zoom * 1.15);
  $("#zoom-out").onclick = () => setZoom(state.zoom / 1.15);
  $("#zoom-fit").onclick = fitWidth;
  $("#region-btn").onclick = () => setRegionMode(!state.regionMode);
  $$("#tabs button").forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
  $("#paper-title").ondblclick = async () => {
    if (!state.paper) return;
    const t = prompt("论文标题", state.paper.title);
    if (!t) return;
    state.paper = await api(`/api/papers/${state.paper.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: t }) });
    $("#paper-title").textContent = state.paper.title;
    loadLibrary();
  };

  const viewer = $("#viewer");
  viewer.addEventListener("scroll", () => renderLater(viewer, () => { updatePageIndicator(); pumpRender(); }));
  viewer.addEventListener("mousedown", (e) => {
    state.downAt = { x: e.clientX, y: e.clientY };
    if (e.target.closest("#sel-pop")) return;
    const pageDiv = e.target.closest(".page");
    if (pageDiv && e.button === 0 && (state.regionMode || e.altKey)) return startRegion(e, pageDiv);
    const tl = e.target.closest(".textLayer");
    if (tl) tl.classList.add("selecting");
  });
  document.addEventListener("mouseup", (e) => {
    $$(".textLayer.selecting").forEach((el) => el.classList.remove("selecting"));
    if (rubber || e.target.closest("#sel-pop")) return;
    if (e.target.closest("#pages")) setTimeout(() => onTextSelection(e), 0);
  });
  document.addEventListener("mousedown", (e) => {
    if (!$("#sel-pop").hidden && !e.target.closest("#sel-pop")) hidePopup();
  });

  const pop = $("#sel-pop");
  $$(".acts button[data-act]", pop).forEach((b) => {
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.onclick = () => askSelection(b.dataset.act);
  });
  $("#note-btn").addEventListener("mousedown", (e) => e.preventDefault());
  $("#note-btn").onclick = startNoteEditor;
  // Enter on an empty box = 解释
  $("form", pop).onsubmit = (e) => { e.preventDefault(); const q = $("input", pop).value.trim(); askSelection(q ? "" : "explain", q); };
  // The Enter that confirms a Chinese IME candidate must not submit the form.
  $("input", pop).addEventListener("keydown", (e) => { if (e.key === "Enter" && composing(e)) { e.preventDefault(); e.stopPropagation(); } });
  viewer.append(pop);
  // Trackpad pinch in Safari / the macOS app arrives as gesture events.
  let gestureStart = 1;
  viewer.addEventListener("gesturestart", (e) => { e.preventDefault(); gestureStart = state.zoom; });
  viewer.addEventListener("gesturechange", (e) => { e.preventDefault(); if (state.pages.length) setZoom(gestureStart * e.scale); });
  viewer.addEventListener("wheel", (e) => {
    if (!e.ctrlKey || !state.pages.length) return;  // pinch / ctrl+scroll zooms
    e.preventDefault();
    setZoom(state.zoom * Math.exp(-e.deltaY * 0.01));
  }, { passive: false });
  $("#page-ind").onclick = () => {
    if (!state.pages.length) return;
    const n = parseInt(prompt(`跳到第几页？（1-${state.pages.length}）`) || "", 10);
    if (n) jumpToPage(Math.max(1, Math.min(state.pages.length, n)) - 1);
  };

  const gta = $("#global-ask textarea");
  gta.addEventListener("input", () => autoGrow(gta));
  gta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !composing(e)) {
      e.preventDefault();
      const q = gta.value.trim();
      if (!q || !state.paper) return;
      gta.value = ""; autoGrow(gta);
      ask({ question: q });
    }
  });

  document.addEventListener("keydown", (e) => {
    const typing = e.target.closest("input, textarea, select, dialog, [contenteditable]") || mm?.isOpen();
    if (e.key === "Escape" && !composing(e)) { hidePopup(); state.pending = null; setRegionMode(false); }
    if (typing || e.metaKey || e.ctrlKey) return;
    if ((e.key === "r" || e.key === "R") && state.paper) setRegionMode(!state.regionMode);
  });

  // Panel resize
  const splitter = $("#splitter");
  const saved = localStorage.getItem("pr.panelW");
  if (saved) document.documentElement.style.setProperty("--panel-w", saved);
  splitter.onmousedown = (e) => {
    e.preventDefault();
    splitter.classList.add("drag");
    const move = (ev) => {
      const w = Math.max(300, Math.min(window.innerWidth * 0.7, window.innerWidth - ev.clientX)) + "px";
      document.documentElement.style.setProperty("--panel-w", w);
      localStorage.setItem("pr.panelW", w);
    };
    const up = () => { splitter.classList.remove("drag"); window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // Drag-and-drop import
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => { if (e.dataTransfer?.types.includes("Files")) { dragDepth++; document.body.classList.add("dragging"); } });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("dragging");
    if (e.dataTransfer?.files.length) uploadFiles([...e.dataTransfer.files]);
  });
}

// Hooks for the macOS app shell (importing PDFs opened from Finder / the Dock).
window.interpretability = {
  openPaper: async (id) => { await loadLibrary(); openPaper(id); },
};

async function main() {
  if (window.innerWidth < 1100) document.body.classList.add("lib-hidden");
  let wasNarrow = window.innerWidth < 1100;
  window.addEventListener("resize", () => renderLater(window, () => {
    const narrow = window.innerWidth < 1100;
    if (narrow !== wasNarrow) document.body.classList.toggle("lib-hidden", narrow);
    wasNarrow = narrow;
    if (state.fitMode) fitWidth();
  }));
  wire();
  await loadSettings();
  await loadLibrary();
  const last = localStorage.getItem("pr.last");
  if (last && state.papers.some((p) => p.id === last)) openPaper(last);
}

main();
