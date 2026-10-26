// Derivation map (推导图): a full-window, editable mind map of how the paper argues.
// Nodes carry where they come from (Figure / Eq. / § / page, and an exact quote checked against
// the PDF), figure nodes show the figure itself, and dependency arrows link steps across branches.
import MindElixir from "/static/vendor/mind-elixir/MindElixir.js";

const KIND = {
  root: { label: "", color: "#c2410c" },
  branch: { label: "", color: "#7c2d12" },
  problem: { label: "问题", color: "#dc2626" },
  idea: { label: "想法", color: "#d97706" },
  assumption: { label: "假设", color: "#9333ea" },
  method: { label: "方法", color: "#2563eb" },
  equation: { label: "公式", color: "#0891b2" },
  evidence: { label: "证据", color: "#059669" },
  result: { label: "结论", color: "#16a34a" },
  limitation: { label: "局限", color: "#6b7280" },
  note: { label: "我的", color: "#a16207" },
};

export function initMindmap(ctx) {
  const { state, api, h, $, toast } = ctx;
  let mind = null;
  let deps = [];
  let saveTimer = null;
  let selected = null;
  let depMode = localStorage.getItem("pr.mmDeps") || "sel";
  const view = $("#mm-view");

  // ---- conversion between our map and Mind Elixir's data

  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  function topicHTML(text) {
    // plain text with $LaTeX$
    return esc(text).replace(/\$([^$\n]+)\$/g, (m, tex) => {
      try { return katex.renderToString(tex.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"), { throwOnError: false }); }
      catch { return m; }
    });
  }

  function tagsFor(n) {
    const tags = [];
    const k = KIND[n.kind];
    if (k?.label) tags.push({ text: k.label, style: { background: k.color, color: "#fff" } });
    for (const r of n.refs || []) tags.push({ text: r, className: "mm-ref" });
    if (n.quote) tags.push(n.verified ? { text: "✓ 原文", className: "mm-ok" } : { text: "⚠ 引用未核实", className: "mm-bad" });
    return tags;
  }

  function styleFor(n) {
    if (n.kind === "root") return { background: "#c2410c", color: "#fff", fontSize: "18px", fontWeight: "600" };
    if (n.kind === "branch") return { fontWeight: "600", fontSize: "15px" };
    return { border: `1.5px solid ${KIND[n.kind]?.color || "#999"}` };
  }

  async function figureImage(n) {
    const ref = (n.refs || []).find((r) => /^(Figure|Table) \d+$/.test(r));
    const fig = ref && state.anchors?.figures?.[ref];
    if (!fig || !state.pages[fig.page - 1]) return undefined;
    try {
      const url = await ctx.renderCrop(fig.page - 1, fig.bbox, 220);
      const pv = state.pages[fig.page - 1];
      const ratio = ((fig.bbox[3] - fig.bbox[1]) * pv.base.height) / ((fig.bbox[2] - fig.bbox[0]) * pv.base.width);
      return { url, width: 200, height: Math.round(Math.min(260, 200 * ratio)), fit: "contain" };
    } catch { return undefined; }
  }

  async function toME(n) {
    const kids = await Promise.all((n.children || []).map(toME));
    return {
      id: n.id, topic: n.text || "（空）", expanded: n.expanded !== false,
      style: styleFor(n), tags: tagsFor(n), branchColor: n.kind === "branch" ? KIND[n.children?.[0]?.kind]?.color : undefined,
      image: n.kind !== "branch" && n.kind !== "root" ? await figureImage(n) : undefined,
      metadata: { kind: n.kind, refs: n.refs || [], quote: n.quote || "", page: n.page, verified: n.verified, spans: n.spans },
      children: kids,
    };
  }

  function fromME(o) {
    const m = o.metadata || {};
    return {
      id: o.id, text: o.topic, kind: m.kind || "note", refs: m.refs || [], quote: m.quote || "",
      page: m.page, verified: m.verified, spans: m.spans, expanded: o.expanded !== false,
      children: (o.children || []).map(fromME),
    };
  }

  function arrows() {
    return deps.map((d, i) => ({
      id: d.id || `dep-${i}`, label: d.label || "", from: d.from, to: d.to,
      style: { stroke: "#ea580c", strokeDasharray: "6,4", strokeWidth: 1.6, labelColor: "#c2410c" },
    }));
  }

  // ---- open / close / render

  async function open() {
    if (!state.paper) return;
    view.hidden = false;
    document.body.classList.add("mm-open");
    status("");
    const r = await api(`/api/papers/${state.paper.id}/mindmap`);
    if (r.map) await (loading = render(r.map));
    else showEmpty(true);
  }

  let loading = null; // the render in progress (figure thumbnails take a moment)

  // Fit the whole map in view once the view has its real size.
  function fit() {
    if (!mind || view.hidden) return;
    requestAnimationFrame(() => mind.scaleFit?.()); // scaleFit also centres the map
  }
  window.addEventListener("resize", () => { clearTimeout(fit.t); fit.t = setTimeout(fit, 200); });

  function close() {
    flush();
    view.hidden = true;
    document.body.classList.remove("mm-open");
  }

  function showEmpty(on) {
    $("#mm-empty").hidden = !on;
    $("#mm-canvas").hidden = on;
    $("#mm-gen").textContent = on ? "✨ 生成推导图" : "✨ 重新生成";
  }

  async function render(map) {
    showEmpty(false);
    deps = map.deps || [];
    state.mindmapPid = state.paper.id;
    const data = { nodeData: await toME({ ...map.root, kind: "root" }), arrows: arrows() };
    const el = $("#mm-canvas");
    el.innerHTML = "";
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    mind = new MindElixir({
      el, direction: MindElixir.SIDE, editable: true, toolBar: true, keypress: true, allowUndo: true,
      contextMenu: {
        focus: true, link: true,
        extend: [
          { name: "↗ 定位原文", onclick: locate },
          { name: "＋ 让 AI 展开", onclick: expand },
          { name: "💬 就此提问", onclick: askAbout },
        ],
      },
      theme: dark ? MindElixir.DARK_THEME : undefined,
      markdown: (text) => topicHTML(text),
    });
    mind.init(data);
    mind.bus.addListener("operation", (op) => {
      if (op.name === "createArrow") applyDepMode(); // show the arrow the reader just drew
      if (op.name !== "beginEdit") queueSave();
    });
    mind.bus.addListener("selectNodes", (nodes) => { selected = nodes[0] || null; updateBar(); applyDepMode(); });
    mind.bus.addListener("unselectNodes", () => { selected = null; updateBar(); applyDepMode(); });
    const src = map.source?.backend ? `${map.edited ? "已人工修改 · " : ""}${new Date(map.time * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "";
    status(src);
    applyDepMode();
    updateBar();
    fit();
  }

  // Dependency arrows: only those touching the selected node, all, or none.
  function applyDepMode() {
    const style = $("#mm-dep-style") || document.head.appendChild(h("style", { id: "mm-dep-style" }));
    if (depMode === "all") { style.textContent = ""; return; }
    // Arrows are <g data-linkid=ID>; their labels are .svg-label[data-svg-id="a-ID"].
    const hideAll = "#mm-canvas [data-linkid], #mm-canvas .svg-label[data-type=arrow] { display: none !important; }";
    if (depMode === "off" || !selected) { style.textContent = hideAll; return; }
    const ids = (mind?.arrows || []).filter((a) => a.from === selected.id || a.to === selected.id).map((a) => a.id);
    style.textContent = hideAll + ids.map((id) =>
      `#mm-canvas [data-linkid="${id}"] { display: inline !important; } #mm-canvas .svg-label[data-svg-id="a-${id}"] { display: block !important; }`).join("");
  }

  function updateBar() {
    const has = !!selected && selected.metadata?.kind !== "branch";
    $("#mm-locate").disabled = !(has && (selected.metadata?.page || selected.metadata?.spans));
    $("#mm-expand").disabled = !selected;
    $("#mm-ask").disabled = !has;
  }

  function status(text) { $("#mm-status").textContent = text; }

  // ---- saving edits

  function queueSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 800);
    status("保存中…");
  }

  async function flush() {
    if (!saveTimer || !mind) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    const pid = state.mindmapPid;
    const d = mind.getData();
    const root = fromME(d.nodeData);
    root.kind = "root";
    // Arrows (including ones the reader drew) whose ends still exist.
    const ids = new Set();
    (function walk(n) { ids.add(n.id); n.children.forEach(walk); })(root);
    deps = (d.arrows || []).filter((a) => ids.has(a.from) && ids.has(a.to))
      .map((a) => ({ id: a.id, from: a.from, to: a.to, label: a.label || "" }));
    try {
      await api(`/api/papers/${pid}/mindmap`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ root, deps }) });
      status("已保存 · 你改过的导图会作为记忆给模型看");
    } catch (e) { status(`没保存成功：${e.message}`); }
  }

  // ---- actions

  async function generate() {
    if (mind && !confirm("重新生成会替换现在的导图（包括你的修改），继续？")) return;
    const pid = state.paper.id;
    const btn = $("#mm-gen");
    btn.disabled = true;
    status("正在生成…（模型在读论文，大约 1 分钟）");
    try {
      const resp = await fetch(`/api/papers/${pid}/mindmap/generate`, { method: "POST" });
      let result = null, error = null;
      await ctx.readSSE(resp, (ev) => {
        if (ev.type === "progress" && ev.nodes) status(`正在生成… 已写 ${ev.nodes} 个节点`);
        if (ev.type === "done") result = ev.map;
        if (ev.type === "error") error = ev.message;
      });
      if (error) throw new Error(error);
      if (result && state.paper?.id === pid && !view.hidden) await render(result);
    } catch (e) {
      status(`生成失败：${e.message}`);
    } finally {
      btn.disabled = false;
    }
  }

  function locate() {
    const m = selected?.metadata;
    if (!m) return;
    const target = m.spans
      ? { kind: "quote", label: "原文", page: m.spans[0].page, spans: m.spans, rects: m.spans[0].rects, bbox: m.spans[0].rects[0], verified: true }
      : figureTarget(m) || (m.page ? { kind: "page", label: `p.${m.page}`, page: m.page, bbox: [0, 0, 1, 1] } : null);
    if (!target) return toast("这个节点没有标出处");
    close();
    ctx.jumpTo(target);
  }

  function figureTarget(m) {
    const A = state.anchors || {};
    for (const r of m.refs || []) {
      let x;
      if ((x = r.match(/^(Figure|Table) (\d+)$/)) && A.figures?.[r]) return { kind: "figure", label: r, ...A.figures[r] };
      if ((x = r.match(/^Eq\.?\s*\((\w+)\)$/)) && A.equations?.[x[1]]) return { kind: "equation", label: r, ...A.equations[x[1]] };
      if ((x = r.match(/^§\s*([\w.]+)$/)) && A.sections?.[x[1]]) return { kind: "section", label: r, ...A.sections[x[1]] };
    }
    return null;
  }

  async function expand() {
    if (!selected) return;
    const node = fromME(selected);
    const path = [];
    for (let p = selected.parent; p; p = p.parent) path.unshift({ text: p.topic });
    status("正在展开…");
    try {
      const r = await api(`/api/papers/${state.paper.id}/mindmap/expand`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ node, path }) });
      if (!r.children.length) return status("模型没有给出可以展开的内容");
      const el = mind.findEle(selected.id);
      for (const c of r.children) await mind.addChild(el, await toME(c));
      status(`展开了 ${r.children.length} 个节点`);
      queueSave();
    } catch (e) { status(`展开失败：${e.message}`); }
  }

  function askAbout() {
    const m = selected?.metadata;
    if (!m) return;
    const refs = (m.refs || []).join("、");
    close();
    ctx.ask({ question: `关于推导图里的这一点：「${selected.topic}」${refs ? `（${refs}）` : ""}。请结合原文讲清楚它是怎么得出的、依赖哪些前提。`, action: "" });
  }

  let exportCss = "";

  // KaTeX's stylesheet with its fonts inlined (about 300 KB): an exported image cannot load
  // font files, and fallback fonts make formulas wider than their nodes.
  async function katexCssWithEmbeddedFonts() {
    const css = await fetch("/static/vendor/katex/katex.min.css").then((r) => r.text());
    const files = [...new Set([...css.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g)].map((m) => m[1]))];
    const data = {};
    await Promise.all(files.map(async (f) => {
      const buf = await fetch(`/static/vendor/katex/${f}`).then((r) => r.blob());
      data[f] = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(buf); });
    }));
    return css.replace(/src:url\((fonts\/[^)]+\.woff2)\) format\("woff2"\)[^;}]*/g,
      (m, f) => `src:url(${data[f].replace(/^data:[^;]*;/, "data:font/woff2;")}) format("woff2")`);
  }

  async function exportAs(kind) {
    if (loading) { status("等导图加载完…"); await loading.catch(() => {}); }
    if (!mind) return toast("还没有推导图");
    try {
      await flush();
      let body = { kind };
      if (kind === "png") {
        // The image is drawn from an SVG snapshot: it needs KaTeX's styles (or formulas turn into
        // doubled raw text) and our tag colours.
        exportCss ||= (await katexCssWithEmbeddedFonts()) +
          ".katex-mathml{display:none}.katex{font-size:1em}" + // same size as on screen (see style.css)
          // Each node's text box is exactly as wide as on screen; rounding can then wrap a formula
          // onto the tags below. A little slack keeps it on one line.
          "foreignObject{overflow:visible}foreignObject>div{margin-right:-10px!important}" +
          ".tags span.mm-ref{background:#fdeee4;color:#c2410c}" +
          ".tags span.mm-ok{background:#dcfce7;color:#15803d}.tags span.mm-bad{background:#fee2e2;color:#b91c1c}";
        // Mind Elixir exports a node's plain text unless it has dangerouslySetInnerHTML, so lend the
        // rendered formula HTML to those nodes just for the export.
        const withMath = [...$("#mm-canvas").querySelectorAll("me-tpc")].filter((t) => t.text?.querySelector?.(".katex"));
        withMath.forEach((t) => (t.nodeObj.dangerouslySetInnerHTML = t.text.innerHTML));
        let blob;
        try { blob = await mind.exportPng(false, exportCss); }
        finally { withMath.forEach((t) => delete t.nodeObj.dangerouslySetInnerHTML); }
        body.data = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
      }
      const r = await api(`/api/papers/${state.paper.id}/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      toast(`已保存到 ${r.path.replace(/^.*\/Downloads\//, "下载/")}`);
    } catch (e) { toast(`导出失败：${e.message}`); }
  }

  // ---- wiring

  $("#map-btn").onclick = () => (view.hidden ? open() : close());
  $("#mm-close").onclick = close;
  $("#mm-gen").onclick = generate;
  $("#mm-empty-gen").onclick = generate;
  $("#mm-locate").onclick = locate;
  $("#mm-expand").onclick = expand;
  $("#mm-ask").onclick = askAbout;
  const depSel = $("#mm-deps");
  depSel.value = depMode;
  depSel.onchange = () => { depMode = depSel.value; localStorage.setItem("pr.mmDeps", depMode); applyDepMode(); };
  const exp = $("#mm-export");
  exp.onchange = () => { const k = exp.value; exp.value = ""; if (k) exportAs(k); };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !view.hidden && !e.target.closest("[contenteditable], input, textarea")) close();
  });
  window.addEventListener("beforeunload", flush);

  return { open, close, isOpen: () => !view.hidden, onPaperChange: () => { flush(); close(); mind = null; } };
}
