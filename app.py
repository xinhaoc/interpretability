"""interpretability: import a paper, let a model read it once, then ask about any line,
equation or figure while you read.

Run:  python app.py    (opens http://127.0.0.1:8765)
"""
import asyncio
import base64
import json
import os
import re
import sys
import time
import uuid
import webbrowser
from pathlib import Path

import fitz  # PyMuPDF
import httpx
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import anchors
import backends
import latex
import mindmap
import memory
import paper_tools
import vocab
from backends import BACKENDS, TOOL_BACKENDS, BackendError, can_see

ROOT = Path(__file__).parent
DATA = Path(os.environ.get("INTERPRETABILITY_DATA") or os.environ.get("PAPER_READER_DATA") or Path.home() / "Interpretability")
OLD_DATA = Path.home() / "PaperReader"  # where data lived before the rename
if "INTERPRETABILITY_DATA" not in os.environ and "PAPER_READER_DATA" not in os.environ \
        and not DATA.exists() and OLD_DATA.exists():
    OLD_DATA.rename(DATA)
PAPERS = DATA / "papers"
PAPERS.mkdir(parents=True, exist_ok=True)
SETTINGS_FILE = DATA / "settings.json"

DEFAULT_SETTINGS = {
    "backend": "claude_cli",
    "language": "中文",
    "auto_digest": True,
    "attach_image_for_text": True,
    "context_mode": "memory",  # memory | full
    "distill_qa": True,
    "backends": {
        "claude_cli": {"model": "", "path": ""},
        "anthropic": {"model": "claude-opus-5-5", "api_key": "", "base_url": "", "effort": "medium"},
        "openai": {"base_url": "http://localhost:11434/v1", "model": "", "api_key": "", "vision": True,
                   "max_context_chars": 60000},
        "codex": {"model": "", "path": "", "effort": "medium"},
        "mock": {},
    },
}
BIG_CONTEXT_CHARS = 600_000  # ~150k tokens; Claude / Codex take the whole paper
MASK = "••••"


# --------------------------------------------------------------------------- settings

def load_settings():
    s = json.loads(json.dumps(DEFAULT_SETTINGS))
    if SETTINGS_FILE.exists():
        saved = json.loads(SETTINGS_FILE.read_text())
        for k, v in saved.items():
            if k == "backends":
                for b, cfg in v.items():
                    s["backends"].setdefault(b, {}).update(cfg)
            else:
                s[k] = v
    return s


def masked(s):
    s = json.loads(json.dumps(s))
    for cfg in s["backends"].values():
        if cfg.get("api_key"):
            cfg["api_key"] = MASK + cfg["api_key"][-4:]
    return s


def source_of(settings):
    name = settings["backend"]
    return {"backend": name, "model": settings["backends"].get(name, {}).get("model", "")}


def context_limit(settings):
    if settings["backend"] == "openai":
        return int(settings["backends"]["openai"].get("max_context_chars") or 60000)
    return BIG_CONTEXT_CHARS


# --------------------------------------------------------------------------- paper storage

def pdir(pid):
    d = PAPERS / pid
    if not re.fullmatch(r"[0-9a-f]{12}", pid) or not d.exists():
        raise HTTPException(404, "paper not found")
    return d


def read_json(path, default):
    return json.loads(path.read_text()) if path.exists() else default


def write_json(path, obj):
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1))
    tmp.replace(path)


def update_meta(d, **fields):
    """Change a few fields of meta.json without overwriting what others changed meanwhile."""
    with memory.lock(d):
        meta = read_json(d / "meta.json", {})
        meta.update(fields)
        write_json(d / "meta.json", meta)
        return meta


TEXT_VERSION = 2  # 2: PDF's own reading order (sort=True interleaved two-column lines)


def page_texts(doc):
    return [clean(p.get_text("text")) for p in doc]


def clean(text):
    lines = (re.sub(r"[ \t]+", " ", ln).strip() for ln in text.splitlines())
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def guess_title(doc):
    t = (doc.metadata or {}).get("title", "").strip()
    if len(t) > 8 and not re.search(r"\.(dvi|tex|pdf|docx?)$|^untitled|microsoft word", t, re.I):
        return t
    page = doc[0]
    best, best_size = "", 0
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            text = "".join(s["text"] for s in line["spans"]).strip()
            size = max((s["size"] for s in line["spans"]), default=0)
            if line["bbox"][1] > page.rect.height * 0.5 or len(text) < 4 or "arXiv" in text:
                continue
            if size > best_size + 0.5:
                best, best_size = text, size
            elif abs(size - best_size) <= 0.5 and best and len(best) < 200:
                best += " " + text  # multi-line title
    return best or "Untitled"


def import_pdf(data: bytes, filename: str, source: str = ""):
    if not data.startswith(b"%PDF"):
        raise HTTPException(400, "这不是 PDF 文件")
    try:
        doc = fitz.open(stream=data, filetype="pdf")
    except Exception:
        raise HTTPException(400, "PDF 文件损坏，打不开")
    if doc.needs_pass:
        raise HTTPException(400, "这个 PDF 有密码保护，请先去掉密码再导入")
    if doc.page_count == 0:
        raise HTTPException(400, "这个 PDF 没有页面")
    pages = page_texts(doc)
    pid = uuid.uuid4().hex[:12]
    d = PAPERS / pid
    (d / "crops").mkdir(parents=True)
    (d / "paper.pdf").write_bytes(data)
    write_json(d / "pages.json", pages)
    meta = {"id": pid, "title": guess_title(doc), "filename": filename, "source": source,
            "num_pages": len(doc), "chars": sum(map(len, pages)), "added": time.time(), "text_v": TEXT_VERSION}
    write_json(d / "meta.json", meta)
    write_json(d / "threads.json", [])
    return meta


def paper_text(pages, page_nums=None):
    nums = page_nums if page_nums is not None else range(len(pages))
    return "\n".join(f'<page n="{i + 1}">\n{pages[i].strip()}\n</page>' for i in nums)


def pages_within(pages, center, limit):
    """Pages around `center` (0-based) whose total text fits in `limit` chars."""
    chosen, total = [], 0
    order = [center] + [c for k in range(1, len(pages)) for c in (center - k, center + k)]
    for i in order:
        if 0 <= i < len(pages) and total + len(pages[i]) <= limit:
            chosen.append(i)
            total += len(pages[i])
    return sorted(chosen)


# --------------------------------------------------------------------------- prompts

GUIDE = """How to answer:
- Ground every claim in the paper. Point to where things come from: [p.N], and equation / section / figure numbers when the paper has them. Write them as Figure N, Table N, Eq. (N), §N.N, and cite the paper's references as [N]; the reader can click these to jump there.
- When a point rests on the paper's wording or numbers, quote it exactly, in the paper's own language, in curly quotes followed by its page, like “we suspect that for large values of d_k” [p.4]. Copy the words exactly and keep quotes short (5-25 words): the app checks each quote against the PDF and highlights it. Never present your notes' paraphrase as a quote.
- Keep what the paper says apart from your own background knowledge or inference, and label the latter in the reply language (e.g. 「背景知识」「我的推断」 when replying in Chinese).
- Equations: define every symbol and say where the paper introduces it; then give the intuition; then say how the equation is used later.
- Figures and tables: say what is plotted or measured, how to read the axes / columns, the key takeaway, and which claim it supports.
- Be direct and concrete. No filler, no restating the question, no generic praise of the paper.
- Math in LaTeX: $...$ inline, $$...$$ for display.
- Reply in {language}. Keep standard technical terms in English, with a short gloss the first time."""

TOOLS_LINE = ("When you need exact wording, numbers, or details beyond your memory and the current page, use the tools: "
              "search_paper finds passages by keywords, read_pages reads whole pages (use the outline to find the right "
              "section), view_page shows a page or part of it as an image (for figures, tables, equations). "
              "Check instead of guessing, especially before quoting.")
NO_TOOLS_LINE = ("Excerpts retrieved from the paper for this question are in the reader's message. If what you need "
                 "is in neither your memory nor those excerpts, say so instead of guessing.")


def outline(d):
    """Numbered sections with their pages, from the PDF's table of contents."""
    try:
        secs = anchors.get(d)["sections"]
    except Exception:
        return ""
    rows = [f"{'  ' * k.count('.')}{k} {v['title']} (p.{v['page']})" for k, v in secs.items()
            if re.fullmatch(r"(\d+|[A-Z])(\.\d+)*", k)]
    return "<outline>\n" + "\n".join(rows) + "\n</outline>" if rows else ""


def build_system(d, meta, pages, settings, focus_page, tools_on):
    """Returns (system prompt, effective mode). Stable parts first so they stay cached."""
    mode = settings.get("context_mode", "memory")
    mem = memory.render(d)
    toc = outline(d)
    if mem and toc:
        mem = toc + "\n\n" + mem
    if mode == "memory" and not mem:
        mode = "full"  # not read yet: nothing to remember, so send the text
    title = meta["title"]
    if mode == "memory":
        parts = [
            "You are a reading companion helping a researcher read one paper closely. You read the whole paper "
            "earlier; below is your memory of it: your reading notes and descriptions of every figure and table. "
            "The full text is not in your context; the reader's message includes the page they are on. "
            + (TOOLS_LINE if tools_on else NO_TOOLS_LINE),
            f'<paper_memory title="{title}" pages="{meta["num_pages"]}">\n{mem}\n</paper_memory>',
        ]
    else:
        limit = context_limit(settings)
        budget = limit - len(mem)
        fits = sum(map(len, pages)) <= budget
        nums = None if fits else pages_within(pages, focus_page, max(budget, 4000))
        scope = ("the full text of the paper" if fits else
                 f"pages {', '.join(str(n + 1) for n in nums)} of the paper (the rest did not fit; rely on your memory for the rest)")
        tex = latex_block(d, budget - sum(map(len, pages))) if fits else ""
        parts = [
            "You are a reading companion helping a researcher read one paper closely. "
            f"Below is {scope}, extracted from the PDF. Extraction garbles math, tables and figure text; "
            "when an image of the region is attached, trust the image over the extracted text."
            + (" " + LATEX_NOTE if tex else ""),
            f'<paper title="{title}" pages="{meta["num_pages"]}">\n{paper_text(pages, nums)}\n</paper>',
        ]
        if tex:
            parts.append(tex)
        if mem:
            parts.append(f"Your memory of this paper from your first full read:\n<paper_memory>\n{mem}\n</paper_memory>")
    parts.append(GUIDE.format(language=settings["language"]))
    reader = memory.render_reader(d)
    if reader:
        parts.append(reader)
    qa = memory.render_qa(d)
    if qa:
        parts.append(qa)
    return "\n\n".join(parts), mode


DIGEST_PROMPT = """Read the whole paper carefully, then write reading notes. The reader will read the paper next to these notes, and you will get them back as your memory of the paper whenever the reader asks about a line, an equation or a figure (often without the full text), so make them precise and complete.

Write the notes in {language} (headings too), in Markdown, with these sections:
1. TL;DR: 3-5 sentences.
2. Problem and motivation: what gap, and why it matters.
3. Key ideas and contributions.
4. Method walkthrough, in the paper's own order, with [p.N] references.
5. Notation table (| symbol | meaning | where defined |), covering every symbol used in the main equations.
6. Key equations: for each important equation (use its number and write it out in LaTeX), what it computes and why it matters.
7. Figures and tables: one entry each, with what it shows and the takeaway.
8. Experiments: setup (datasets, baselines, metrics, hardware, hyperparameters) and main results with the actual numbers.
9. Assumptions, limitations, and things the paper leaves unexplained.
10. Background a reader may need: terms and prior work, one line each.

Start directly with section 1."""

CHUNK_PROMPT = """This is part {i} of {n} of a paper (pages {a}-{b}). Write dense notes on this part in {language}: method steps, every symbol and what it means (with page), every equation and what it does, every figure/table and its takeaway, experimental numbers. These notes will later be merged into notes for the whole paper.

<paper_part>
{text}
</paper_part>"""

MERGE_PROMPT = """Below are notes on consecutive parts of one paper titled "{title}". Merge them into a single set of reading notes for the whole paper.

{parts}

""" + DIGEST_PROMPT.split("\n\n", 1)[1]

ACTIONS = {
    "explain": ("解释", "Explain the selection: what it says, why it is there in the paper's argument, and any background needed to follow it."),
    "math": ("推导", "Go through the math step by step. For each step, write the equation as the paper writes it (with its number), then list every symbol in it (never skip one because it looks obvious) with its meaning, its type or shape (e.g. $\\mathbb{R}^{n \\times d_k}$) and where the paper defines it. Fill in the steps the paper skips and say which earlier equations they use. Do not invent sizes the paper does not give; if you pick sizes to illustrate, say so. End with a tiny worked example that pushes actual numbers through the equation. Mark what comes from background knowledge rather than the paper."),
    "simple": ("通俗讲", "Explain it as simply as possible, then give one small concrete example with actual numbers."),
    "connect": ("联系全文", "How does this connect to the rest of the paper? What earlier parts does it rely on, and where is it used later (method, experiments, claims)?"),
    "critique": ("挑毛病", "Critically examine it: hidden assumptions, possible flaws, missing comparisons or ablations, and what would make it more convincing."),
    "translate": ("翻译", "Translate the selection into the language you answer in. Output only the translation: no preamble, no explanation, no quotes from the paper. Keep equations and symbols as LaTeX, keep citation marks like [12], and on first use put the English term in parentheses after each technical term, e.g. 稀疏自编码器 (sparse autoencoder). If the selection is an image, translate the text in it."),
}
NO_TOOL_ACTIONS = {"translate"}  # quick answers: no need to look things up in the paper


def region_text(pdf_path, page_no, rect, pad_y=0.0):
    doc = fitz.open(pdf_path)
    page = doc[page_no]
    W, H = page.rect.width, page.rect.height
    r = fitz.Rect(rect[0] * W, (rect[1] - pad_y) * H, rect[2] * W, (rect[3] + pad_y) * H)
    if pad_y:
        r = fitz.Rect(0, r.y0, W, r.y1)
    r = r * page.derotation_matrix
    return clean(page.get_text("text", clip=r))


STOPWORDS = set("this that with from what which when where does there their about into than then them they have been were will would could should these those also only very much more most such some each both other".split())


def retrieve(d, pages, question, sel_text):
    """Harness-side lookup for backends that cannot call tools: pages and passages the question points at."""
    out, budget = [], 7000
    q = question + " " + (sel_text or "")
    for m in re.finditer(r"(?:第\s*(\d+)\s*页|\bpage\s*(\d+)|\bp\.\s*(\d+))", q, re.I):
        n = int(next(g for g in m.groups() if g)) - 1
        if 0 <= n < len(pages) and budget > 0:
            out.append(f'<page n="{n + 1}">\n{pages[n][:budget]}\n</page>')
            budget -= len(out[-1])
    words = [w for w in re.findall(r"[A-Za-z][A-Za-z\-]{3,}", question) if w.lower() not in STOPWORDS]
    seen = set()
    for w in words[:5]:
        if w.lower() in seen or budget <= 0:
            continue
        seen.add(w.lower())
        hits = paper_tools.search_paper(d, w, max_hits=3)
        if not hits.startswith("No matches"):
            out.append(hits[:budget])
            budget -= len(out[-1])
    return "\n\n".join(out)


def build_question(d, pages, sel, action, question, mode, tools_on):
    lines = []
    if sel:
        p = sel["page"]
        kind = {"text": "text", "region": "region (equation, figure, table, or text block; see the attached image)"}[sel["kind"]]
        lines.append(f"The reader is on page {p + 1} and selected this {kind}:")
        lines.append(f"<selection>\n{sel.get('text') or '(no extractable text; see image)'}\n</selection>")
        if sel.get("image"):
            lines.append("An image of the selected area of the page is attached.")
        if mode == "memory":
            lines.append(f"Full text of page {p + 1} (extracted; math and tables may be garbled):\n"
                         f'<page n="{p + 1}">\n{pages[p]}\n</page>')
        elif sel.get("bbox"):
            around = region_text(d / "paper.pdf", p, sel["bbox"], pad_y=0.12)
            if around:
                lines.append(f"Text around the selection on page {p + 1}:\n<surrounding>\n{around}\n</surrounding>")
    else:
        lines.append("The reader asks about the paper as a whole.")
    if mode == "memory" and not tools_on:
        found = retrieve(d, pages, question, sel.get("text", "") if sel else "")
        if found:
            lines.append(f"Excerpts retrieved from the paper for this question:\n<excerpts>\n{found}\n</excerpts>")
    instr = ACTIONS[action][1] if action in ACTIONS else ""
    if question.strip():
        lines.append(f"Reader's question: {question.strip()}")
        if instr:
            lines.append(f"(Requested mode: {instr})")
    elif instr:
        lines.append(instr)
    return "\n\n".join(lines)


# --------------------------------------------------------------------------- first read (notes + figures)

class Job:
    def __init__(self):
        self.text = ""
        self.phase = ""
        self.status = "running"  # running | done | error
        self.error = ""
        self.cond = asyncio.Condition()
        self.task = None

    async def push(self, text="", status=None, error="", phase=None, reset=False):
        async with self.cond:
            if reset:
                self.text = ""
            self.text += text
            if phase is not None:
                self.phase = phase
            if status:
                self.status, self.error = status, error
            self.cond.notify_all()


JOBS: dict[str, Job] = {}


async def collect(backend, system, msgs, cfg, on_status=None):
    out = ""
    async for chunk in backend(system, msgs, cfg):
        if isinstance(chunk, str):
            out += chunk
        elif on_status and "status" in chunk:  # a slow backend saying it is still working
            await on_status(chunk["status"])
    return out


def phase_status(job, phase):
    """on_status for collect(): show the backend's status after the current phase."""
    return lambda st: job.push(phase=f"{phase} {st}")


LATEX_NOTE = ("The authors' LaTeX source is also given. Use it for exact equations, symbols and macro definitions; "
              "use the PDF text for page numbers.")


def latex_block(d, budget):
    p = d / "latex.tex"
    if not p.exists():
        return ""
    src = p.read_text()
    return f"<latex_source>\n{src}\n</latex_source>" if len(src) <= budget else ""


async def read_notes(d, meta, pages, settings, job):
    backend = BACKENDS[settings["backend"]]
    cfg = settings["backends"].get(settings["backend"], {})
    lang = settings["language"]
    limit = context_limit(settings)
    await job.push(phase="正在通读全文、写笔记…", reset=True)
    if sum(map(len, pages)) <= limit - 2000:
        tex = latex_block(d, limit - 2000 - sum(map(len, pages)))
        system = ("You are a careful research assistant reading a paper." + (" " + LATEX_NOTE if tex else "") + "\n\n"
                  f'<paper title="{meta["title"]}">\n{paper_text(pages)}\n</paper>' + ("\n\n" + tex if tex else ""))
        msgs = [{"role": "user", "content": [{"type": "text", "text": DIGEST_PROMPT.format(language=lang)}]}]
        async for chunk in backend(system, msgs, cfg):
            if isinstance(chunk, str):
                await job.push(chunk)
            elif "status" in chunk:
                await job.push(phase=f"正在通读全文、写笔记… {chunk['status']}")
    else:
        # Paper does not fit: notes per chunk, then merge.
        chunks, cur = [], []
        for i, t in enumerate(pages):
            if cur and sum(len(pages[j]) for j in cur) + len(t) > limit * 0.7:
                chunks.append(cur)
                cur = []
            cur.append(i)
        chunks.append(cur)
        part_notes = []
        for k, ch in enumerate(chunks):
            ph = f"正在读第 {k + 1}/{len(chunks)} 部分（第 {ch[0] + 1}-{ch[-1] + 1} 页）…"
            await job.push(phase=ph)
            prompt = CHUNK_PROMPT.format(i=k + 1, n=len(chunks), a=ch[0] + 1, b=ch[-1] + 1,
                                         language=lang, text=paper_text(pages, ch))
            part_notes.append(await collect(backend, "You are a careful research assistant.",
                                            [{"role": "user", "content": [{"type": "text", "text": prompt}]}], cfg,
                                            phase_status(job, ph)))
        await job.push(phase="正在合并笔记…")
        parts = "\n\n".join(f"<part n={k + 1}>\n{t}\n</part>" for k, t in enumerate(part_notes))
        prompt = MERGE_PROMPT.format(title=meta["title"], parts=parts, language=lang)
        async for chunk in backend("You are a careful research assistant.",
                                   [{"role": "user", "content": [{"type": "text", "text": prompt}]}], cfg):
            if isinstance(chunk, str):
                await job.push(chunk)
            elif "status" in chunk:
                await job.push(phase=f"正在合并笔记… {chunk['status']}")
    memory.save_notes(d, job.text, source_of(settings))


async def read_figures(d, pages, settings, job):
    name = settings["backend"]
    cfg = settings["backends"].get(name, {})
    # Figures with a numbered caption ("Figure 3:"), found in the text ...
    caps = memory.find_captions(pages)
    figs = [{"label": label, "kind": label.split()[0].lower(), "page": i + 1, "caption": cap,
             "bbox": None, "description": ""} for i, label, cap in caps]
    # ... and, on pages without such captions, images and drawings found on the page itself.
    regions = await asyncio.to_thread(memory.find_figure_regions, d / "paper.pdf", {f["page"] - 1 for f in figs})
    extra = [{"label": label, "kind": "figure", "page": p + 1, "caption": near, "bbox": box, "description": "",
              "uncaptioned": True} for p, label, near, box in regions]
    if not figs and not extra:
        memory.save_figures(d, [], source_of(settings))
        return
    if not can_see(name, cfg):
        memory.save_figures(d, figs + extra, {**source_of(settings), "note": "当前模型看不了图，只记录了位置和图注"})
        return
    # Start from what an earlier pass found, so a failed batch never erases good descriptions.
    old = {f["label"]: f for f in memory.figures(d)}
    for f in figs + extra:
        if f["label"] in old:
            f["description"] = old[f["label"]].get("description", "")
            f["bbox"] = f["bbox"] or old[f["label"]].get("bbox")
    by_label = {f["label"]: f for f in figs + extra}
    skipped = set()
    backend = BACKENDS[name]
    system = "You are a careful research assistant who describes figures and tables precisely."

    def apply(out, keep_bbox):
        for item in memory.parse_figure_blocks(out):
            label = re.sub(r"^Fig(?:\.|ure)?\s*(?=\d)", "Figure ", item["label"], flags=re.I)
            f = by_label.get(label)
            if not f:
                continue
            desc = item["description"]
            if desc.upper().startswith("SKIP"):
                skipped.add(label)
            elif desc and not desc.upper().startswith("NOT FOUND"):
                f["description"] = desc
            if item["bbox"] and not keep_bbox:
                f["bbox"] = [max(0.0, min(1.0, v)) for v in item["bbox"]]

    def save():
        memory.save_figures(d, [f for f in figs + extra if f["label"] not in skipped], source_of(settings))

    # Captioned figures: whole pages, 4 at a time; the model also finds each figure's box.
    page_nums = sorted({f["page"] for f in figs})
    page_batches = [page_nums[i:i + 4] for i in range(0, len(page_nums), 4)]
    crop_batches = [extra[i:i + 6] for i in range(0, len(extra), 6)]
    total = len(page_batches) + len(crop_batches)
    step = 0
    for batch in page_batches:
        step += 1
        ph = f"正在看图表（{step}/{total}，第 {', '.join(map(str, batch))} 页）…"
        await job.push(phase=ph)
        content = []
        for pn in batch:
            png = await asyncio.to_thread(paper_tools.view_page, d, pn)
            content += [{"type": "text", "text": f"Page {pn}:"},
                        {"type": "image", "media_type": "image/png", "data": base64.b64encode(png).decode()}]
        items = "\n".join(f"- {f['label']} (page {f['page']}): {f['caption'][:200]}" for f in figs if f["page"] in batch)
        content.append({"type": "text", "text": memory.FIGURE_PROMPT.format(items=items, language=settings["language"])})
        apply(await collect(backend, system, [{"role": "user", "content": content}], cfg, phase_status(job, ph)),
              keep_bbox=False)
        save()  # after each batch
    # Figures without captions: crop each one, 6 per request; their boxes are already known.
    for batch in crop_batches:
        step += 1
        ph = f"正在看图表（{step}/{total}，无编号的图）…"
        await job.push(phase=ph)
        content = []
        for f in batch:
            b = f["bbox"]
            png = await asyncio.to_thread(paper_tools.view_page, d, f["page"], b[0] - 0.01, b[1] - 0.01, b[2] + 0.01, b[3] + 0.01)
            near = f" Text just below it: {f['caption'][:200]}" if f["caption"] else ""
            content += [{"type": "text", "text": f"Item {f['label']} (page {f['page']}).{near}"},
                        {"type": "image", "media_type": "image/png", "data": base64.b64encode(png).decode()}]
        content.append({"type": "text", "text": memory.FIGURE_CROP_PROMPT.format(language=settings["language"])})
        apply(await collect(backend, system, [{"role": "user", "content": content}], cfg, phase_status(job, ph)),
              keep_bbox=True)
        save()
    save()


async def run_digest(pid, job: Job, parts="all"):
    d = PAPERS / pid
    settings = load_settings()
    meta = read_json(d / "meta.json", {})
    pages = read_json(d / "pages.json", [])
    try:
        if sum(map(len, pages)) < 200 * max(1, len(pages)) * 0.1:
            raise BackendError("这个 PDF 几乎没有文字层（可能是扫描件），暂时没法通读。")
        if parts in ("all", "notes"):
            await job.push(phase="正在获取论文源码…")
            await latex.ensure(d, meta, pages)
            if "latex" in meta:
                update_meta(d, latex=meta["latex"])
            await read_notes(d, meta, pages, settings, job)
        else:
            await job.push(memory.notes(d), reset=True)
        if parts in ("all", "figures"):
            await read_figures(d, pages, settings, job)
        update_meta(d, digested=time.time())
        await job.push(status="done", phase="")
    except BackendError as e:
        await job.push(status="error", error=str(e), phase="")
    except Exception as e:  # keep the job from hanging forever
        await job.push(status="error", error=f"{type(e).__name__}: {e}", phase="")


def start_digest(pid, parts="all"):
    job = JOBS.get(pid)
    if job and job.status == "running" and job.task and not job.task.done():
        return job
    job = Job()
    JOBS[pid] = job
    job.task = asyncio.create_task(run_digest(pid, job, parts))
    return job


# --------------------------------------------------------------------------- Q&A → memory

DELETED_THREADS: set[str] = set()


async def distill(pid, tid):
    d = PAPERS / pid
    settings = load_settings()
    thread = next((t for t in read_json(d / "threads.json", []) if t["id"] == tid), None)
    if not thread:
        return
    sel = thread.get("selection")
    lines = []
    if sel:
        what = (sel.get("text") or "")[:600] if sel["kind"] == "text" else f"a region on page {sel['page'] + 1}: {(sel.get('text') or '')[:300]}"
        lines.append(f"[Reader selected on page {sel['page'] + 1}: {what}]")
    for m in thread["messages"]:
        if m["role"] == "user":
            lines.append("Reader: " + (m.get("display") or ACTIONS.get(m.get("action"), ("",))[0] or "(question)"))
        elif m.get("content"):
            lines.append("Assistant: " + m["content"][:5000])
    prompt = memory.DISTILL_PROMPT.format(language=settings["language"], exchange="\n\n".join(lines))
    try:
        out = await collect(BACKENDS[settings["backend"]], "You keep concise notes about a research paper.",
                            [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
                            settings["backends"].get(settings["backend"], {}))
    except Exception as e:
        print(f"distill failed: {e}", file=sys.stderr)
        return
    out = out.strip()
    first = thread["messages"][0]
    with memory.lock(d):
        still = next((t for t in read_json(d / "threads.json", []) if t["id"] == tid), None)
        if not still or still.get("forgotten") or tid in DELETED_THREADS:
            return
        if not out or out.upper().startswith("NONE"):
            memory.save_qa_entry(d, tid, None)
        else:
            memory.save_qa_entry(d, tid, {
                "page": sel["page"] + 1 if sel else None,
                "question": first.get("display") or ACTIONS.get(first.get("action"), ("",))[0],
                "facts": out, "time": time.time(), **source_of(settings)})


# --------------------------------------------------------------------------- app

app = FastAPI()


@app.middleware("http")
async def local_only(request: Request, call_next):
    """Only this app may drive the server: other web pages must not import papers or spend model quota."""
    from fastapi.responses import JSONResponse
    host = request.headers.get("host", "").split(":")[0]
    if host not in ("127.0.0.1", "localhost"):
        return JSONResponse({"detail": "forbidden host"}, status_code=403)
    origin = request.headers.get("origin")
    if request.method not in ("GET", "HEAD", "OPTIONS") and origin:
        if re.sub(r"^https?://", "", origin).split(":")[0] not in ("127.0.0.1", "localhost"):
            return JSONResponse({"detail": "forbidden origin"}, status_code=403)
    return await call_next(request)


def sse(obj):
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/api/settings")
def get_settings():
    return {"settings": masked(load_settings()), "detected": backends.detect()}


@app.put("/api/settings")
async def put_settings(req: Request):
    new = await req.json()
    old = load_settings()
    for b, cfg in new.get("backends", {}).items():
        if str(cfg.get("api_key", "")).startswith(MASK):
            cfg["api_key"] = old["backends"].get(b, {}).get("api_key", "")
    write_json(SETTINGS_FILE, new)
    return {"settings": masked(load_settings())}


@app.get("/api/papers")
def list_papers():
    out = []
    for d in PAPERS.iterdir():
        if (d / "meta.json").exists():
            m = read_json(d / "meta.json", {})
            m["has_notes"] = memory.has_memory(d)
            m["n_threads"] = len(read_json(d / "threads.json", []))
            out.append(m)
    return sorted(out, key=lambda m: -m.get("opened", m["added"]))


@app.post("/api/papers")
async def upload(file: UploadFile = File(...)):
    meta = await asyncio.to_thread(import_pdf, await file.read(), file.filename or "paper.pdf")
    if load_settings()["auto_digest"]:
        start_digest(meta["id"])
    return meta


def normalize_url(s):
    s = s.strip()
    m = re.search(r"(\d{4}\.\d{4,5})(v\d+)?", s)
    if re.fullmatch(r"(arxiv:)?\d{4}\.\d{4,5}(v\d+)?", s, re.I) or ("arxiv.org" in s and m):
        return f"https://arxiv.org/pdf/{m.group(1)}{m.group(2) or ''}"
    if "openreview.net/forum" in s:
        return s.replace("/forum", "/pdf")
    return s


@app.post("/api/papers/url")
async def import_url(req: Request):
    url = normalize_url((await req.json())["url"])
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "请输入 arXiv 编号或 PDF 链接")
    async with httpx.AsyncClient(follow_redirects=True, timeout=60,
                                 headers={"User-Agent": "Mozilla/5.0 interpretability"}) as c:
        r = await c.get(url)
    if r.status_code != 200:
        raise HTTPException(400, f"下载失败：HTTP {r.status_code}")
    meta = await asyncio.to_thread(import_pdf, r.content, url.rsplit("/", 1)[-1] + ".pdf", url)
    if load_settings()["auto_digest"]:
        start_digest(meta["id"])
    return meta


def memory_view(d):
    qa = memory.qa(d)
    return {"notes": memory.notes(d), "figures": memory.figures(d),
            "qa": [{"thread_id": k, **v} for k, v in sorted(qa.items(), key=lambda kv: kv[1].get("time", 0))],
            "info": memory.info(d), "has_new_notes": bool(memory.new_notes(d)),
            "my_notes": memory.my_notes(d), "annotations": memory.annotations(d)}


@app.get("/api/papers/{pid}")
def get_paper(pid: str):
    d = pdir(pid)
    meta = update_meta(d, opened=time.time())
    job = JOBS.get(pid)
    status = job.status if job else ("done" if memory.has_memory(d) else "none")
    return {"meta": meta, "memory": memory_view(d), "digest_status": status,
            "digest_phase": job.phase if job else "", "threads": read_json(d / "threads.json", [])}


@app.get("/api/papers/{pid}/anchors")
def get_anchors(pid: str):
    return anchors.get(pdir(pid))


@app.post("/api/papers/{pid}/locate")
async def locate(pid: str, req: Request):
    """Check quotes from answers against the PDF: [{page, quote}] -> [{verified, page, rects}]."""
    d = pdir(pid)
    items = (await req.json())["items"][:60]

    def one(it):
        try:
            return paper_tools.locate_quote(d, int(it["page"]), str(it["quote"]))
        except Exception:
            return {"verified": False}
    return await asyncio.to_thread(lambda: [one(it) for it in items])


@app.get("/api/papers/{pid}/find")
async def find(pid: str, q: str = ""):
    """Find in the paper (⌘F): every occurrence with its boxes on the page."""
    d = pdir(pid)
    return {"hits": await asyncio.to_thread(paper_tools.find_text, d, q[:200])}


# --------------------------------------------------------------------------- word book

DEFINING: set[str] = set()


async def define_word(wid):
    if wid in DEFINING:
        return
    DEFINING.add(wid)
    try:
        e = vocab.get(DATA, wid)
        if not e:
            return
        settings = load_settings()
        name = settings["backend"]
        c = e["contexts"][-1] if e["contexts"] else {}
        prompt = vocab.DEFINE_PROMPT.format(title=c.get("title", ""), word=e["word"], sentence=c.get("sentence", ""),
                                            language=settings["language"])
        vocab.update(DATA, wid, status="pending")
        try:
            out = await collect(BACKENDS[name], "You are a concise bilingual dictionary.",
                                [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
                                settings["backends"].get(name, {}))
            fields = vocab.parse_definition(out)
            if not fields.get("meaning"):
                raise BackendError("模型没有按格式回答")
            vocab.update(DATA, wid, **fields, status="ok", error="", defined_by=source_of(settings))
        except Exception as ex:
            vocab.update(DATA, wid, status="error", error=str(ex)[:300])
    finally:
        DEFINING.discard(wid)


def vocab_view():
    words = vocab.load(DATA)
    return {"words": words, "due": vocab.due_count(words), "now": time.time()}


@app.get("/api/vocab")
def get_vocab():
    return vocab_view()


@app.post("/api/vocab")
async def add_vocab(req: Request):
    body = await req.json()
    word = vocab.clean_word(str(body.get("word", "")))[:80]
    if not word:
        raise HTTPException(400, "empty word")
    ctx = {}
    pid = body.get("pid")
    if pid:
        d = pdir(pid)
        page, bbox = int(body.get("page", 0)), body.get("bbox")
        sentence = await asyncio.to_thread(paper_tools.sentence_at, d, page + 1, bbox) if bbox else ""
        ctx = {"pid": pid, "title": read_json(d / "meta.json", {}).get("title", ""), "page": page,
               "bbox": bbox, "sentence": sentence}
    e, needs = vocab.add(DATA, word, ctx)
    if needs:
        asyncio.create_task(define_word(e["id"]))
    return {"word": e, **vocab_view()}


@app.put("/api/vocab/{wid}")
async def edit_vocab(wid: str, req: Request):
    body = await req.json()
    fields = {k: str(v)[:500] for k, v in body.items() if k in vocab.FIELDS}
    if not vocab.update(DATA, wid, **fields, status="ok"):
        raise HTTPException(404, "word not found")
    return vocab_view()


@app.delete("/api/vocab/{wid}")
def delete_vocab(wid: str):
    vocab.delete(DATA, wid)
    return vocab_view()


@app.post("/api/vocab/{wid}/review")
async def review_vocab(wid: str, req: Request):
    grade = (await req.json()).get("grade")
    if grade not in ("again", "hard", "good"):
        raise HTTPException(400, "grade must be again, hard or good")
    if not vocab.review(DATA, wid, grade):
        raise HTTPException(404, "word not found")
    return vocab_view()


@app.post("/api/vocab/{wid}/define")
async def redefine_vocab(wid: str):
    if not vocab.get(DATA, wid):
        raise HTTPException(404, "word not found")
    vocab.update(DATA, wid, status="pending")
    asyncio.create_task(define_word(wid))
    return vocab_view()


@app.get("/api/papers/{pid}/memory")
def get_memory(pid: str):
    return memory_view(pdir(pid))


@app.put("/api/papers/{pid}/memory/notes")
async def edit_notes(pid: str, req: Request):
    d = pdir(pid)
    memory.edit_notes(d, (await req.json())["text"])
    return memory_view(d)


@app.get("/api/papers/{pid}/memory/notes/new")
def get_new_notes(pid: str):
    return {"text": memory.new_notes(pdir(pid))}


@app.post("/api/papers/{pid}/memory/notes/new")
async def resolve_new_notes(pid: str, req: Request):
    d = pdir(pid)
    if (await req.json()).get("accept"):
        memory.accept_new_notes(d)
    else:
        memory.drop_new_notes(d)
    return memory_view(d)


@app.put("/api/papers/{pid}/my-notes")
async def put_my_notes(pid: str, req: Request):
    memory.save_my_notes(pdir(pid), (await req.json())["text"])
    return {"ok": True}


@app.post("/api/papers/{pid}/annotations")
async def add_annotation(pid: str, req: Request):
    d = pdir(pid)
    body = await req.json()
    a = {"id": uuid.uuid4().hex[:12], "page": body["page"], "kind": body["kind"], "bbox": body["bbox"],
         "rects": body.get("rects") or [body["bbox"]], "text": body.get("text", ""), "note": body.get("note", ""),
         "color": body.get("color", "yellow"), "created": time.time(), "updated": time.time()}
    if a["kind"] == "region" and not a["text"]:
        a["text"] = await asyncio.to_thread(region_text, d / "paper.pdf", a["page"], a["bbox"])
    if body.get("image"):
        (d / "crops" / f"a_{a['id']}.png").write_bytes(base64.b64decode(body["image"].split(",", 1)[-1]))
        a["image"] = f"a_{a['id']}.png"
    with memory.lock(d):
        memory.save_annotations(d, memory.annotations(d) + [a])
    return a


@app.patch("/api/papers/{pid}/annotations/{aid}")
async def edit_annotation(pid: str, aid: str, req: Request):
    d = pdir(pid)
    body = await req.json()
    with memory.lock(d):
        items = memory.annotations(d)
        for a in items:
            if a["id"] == aid:
                for k in ("note", "color"):
                    if k in body:
                        a[k] = body[k]
                a["updated"] = time.time()
                memory.save_annotations(d, items)
                return a
    raise HTTPException(404, "annotation not found")


@app.delete("/api/papers/{pid}/annotations/{aid}")
def delete_annotation(pid: str, aid: str):
    d = pdir(pid)
    with memory.lock(d):
        memory.save_annotations(d, [a for a in memory.annotations(d) if a["id"] != aid])
    crop = d / "crops" / f"a_{aid}.png"
    if crop.exists():
        crop.unlink()
    return {"ok": True}


@app.patch("/api/papers/{pid}")
async def patch_paper(pid: str, req: Request):
    d = pdir(pid)
    body = await req.json()
    meta = read_json(d / "meta.json", {})
    if "title" in body:
        meta = update_meta(d, title=body["title"].strip() or meta["title"])
    return meta


@app.delete("/api/papers/{pid}")
def delete_paper(pid: str):
    import shutil
    d = pdir(pid)
    job = JOBS.pop(pid, None)
    if job and job.task and not job.task.done():
        job.task.get_loop().call_soon_threadsafe(job.task.cancel)  # stop a running first read
    shutil.rmtree(d)
    return {"ok": True}


@app.get("/api/papers/{pid}/pdf")
def get_pdf(pid: str):
    return FileResponse(pdir(pid) / "paper.pdf", media_type="application/pdf")


@app.get("/api/papers/{pid}/crops/{name}")
def get_crop(pid: str, name: str):
    if not re.fullmatch(r"(a_)?[0-9a-f]{12}(_\d+)?\.png", name):
        raise HTTPException(404)
    return FileResponse(pdir(pid) / "crops" / name, media_type="image/png")


@app.post("/api/papers/{pid}/digest")
async def digest(pid: str, parts: str = "all"):
    pdir(pid)
    if parts not in ("all", "figures"):
        raise HTTPException(400, "parts must be all or figures")
    job = start_digest(pid, parts)
    return {"status": job.status}


@app.get("/api/papers/{pid}/digest/stream")
async def digest_stream(pid: str):
    pdir(pid)
    job = JOBS.get(pid)
    if not job:
        raise HTTPException(404, "no digest job")

    async def gen():
        sent, phase = 0, None
        while True:
            async with job.cond:
                while len(job.text) == sent and job.phase == phase and job.status == "running":
                    await job.cond.wait()
                text, cur_phase, status, error = job.text, job.phase, job.status, job.error
            if len(text) < sent:  # buffer was reset
                yield sse({"type": "reset"})
                sent = 0
            if len(text) > sent:
                yield sse({"type": "delta", "text": text[sent:]})
                sent = len(text)
            if cur_phase != phase:
                phase = cur_phase
                yield sse({"type": "phase", "text": phase})
            if status != "running":
                yield sse({"type": status, "message": error})
                return

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/api/papers/{pid}/ask")
async def ask(pid: str, req: Request):
    d = pdir(pid)
    body = await req.json()
    settings = load_settings()
    threads = read_json(d / "threads.json", [])
    action = body.get("action") or ""
    question = body.get("question") or ""
    tid = body.get("thread_id")

    if tid:
        thread = next((t for t in threads if t["id"] == tid), None)
        if not thread:
            raise HTTPException(404, "thread not found")
    else:
        thread = {"id": uuid.uuid4().hex[:12], "created": time.time(), "messages": [], "selection": None}
        threads.append(thread)

    # A selection either starts the thread or is added to it as a follow-up.
    sel = body.get("selection")
    if sel:
        if sel["kind"] == "region" and not sel.get("text"):
            sel["text"] = await asyncio.to_thread(region_text, d / "paper.pdf", sel["page"], sel["bbox"])
        img = sel.pop("image", None)
        if img:
            name_ = f"{thread['id']}.png" if not thread["messages"] else f"{thread['id']}_{len(thread['messages'])}.png"
            (d / "crops" / name_).write_bytes(base64.b64decode(img.split(",", 1)[-1]))
            sel["image"] = name_
        if not thread["messages"]:
            thread["selection"] = sel

    meta = read_json(d / "meta.json", {})
    pages = read_json(d / "pages.json", [])
    focus = thread["selection"]["page"] if thread["selection"] else 0
    name = settings["backend"]
    wants_tools = name in TOOL_BACKENDS and action not in NO_TOOL_ACTIONS
    system, mode = await asyncio.to_thread(build_system, d, meta, pages, settings, focus, wants_tools)
    tools_on = wants_tools and mode == "memory"

    first = not thread["messages"]
    if first:
        prompt = await asyncio.to_thread(build_question, d, pages, thread["selection"], action, question, mode, tools_on)
    elif sel:
        prompt = "The reader selected something else to discuss in this conversation.\n\n" + \
            await asyncio.to_thread(build_question, d, pages, sel, action, question, mode, tools_on)
    else:
        prompt = question
    label = ACTIONS[action][0] if action in ACTIONS else ""
    msg = {"role": "user", "prompt": prompt, "display": question or label, "action": action}
    if sel and not first:
        msg["selection"] = sel
    thread["messages"].append(msg)

    # Rebuild the conversation for the model.
    msgs = []
    for i, m in enumerate(thread["messages"]):
        if m["role"] == "assistant" and not (m.get("content") or "").strip():
            continue  # an answer that failed before any text; the API rejects empty turns
        blocks = []
        msel = thread["selection"] if i == 0 else m.get("selection")
        if m["role"] == "user" and msel and msel.get("image"):
            data = (d / "crops" / msel["image"]).read_bytes()
            blocks.append({"type": "image", "media_type": "image/png", "data": base64.b64encode(data).decode()})
        blocks.append({"type": "text", "text": m["prompt"] if m["role"] == "user" else m["content"]})
        msgs.append({"role": m["role"], "content": blocks})

    backend = BACKENDS[name]
    cfg = settings["backends"].get(name, {})
    used_tools = []

    def save(answer, error=""):
        thread["messages"].append({"role": "assistant", "content": answer, "error": error,
                                   "backend": name, "model": cfg.get("model", ""), "mode": mode,
                                   "tools": used_tools})
        if thread["id"] in DELETED_THREADS:
            return  # deleted while answering: don't bring it back
        with memory.lock(d):
            cur = read_json(d / "threads.json", [])
            cur = [t for t in cur if t["id"] != thread["id"]] + [thread]
            write_json(d / "threads.json", sorted(cur, key=lambda t: t["created"]))

    async def gen():
        yield sse({"type": "thread", "thread": thread, "mode": mode})
        answer, saved = "", False
        try:
            async for chunk in backend(system, msgs, cfg, tools=d if tools_on else None):
                if isinstance(chunk, dict) and "status" in chunk:
                    yield sse({"type": "status", "text": chunk["status"]})
                    continue
                if isinstance(chunk, dict):
                    lbl = paper_tools.describe_call(chunk["tool"], chunk.get("input", {}))
                    used_tools.append(lbl)
                    yield sse({"type": "tool", "label": lbl, "name": chunk["tool"], "input": chunk.get("input", {})})
                    continue
                answer += chunk
                yield sse({"type": "delta", "text": chunk})
            save(answer)
            saved = True
            yield sse({"type": "done"})
            if settings.get("distill_qa", True) and memory.has_memory(d) and answer.strip():
                asyncio.create_task(distill(pid, thread["id"]))
        except BackendError as e:
            save(answer, str(e))
            saved = True
            yield sse({"type": "error", "message": str(e)})
        except Exception as e:
            save(answer, f"{type(e).__name__}: {e}")
            saved = True
            yield sse({"type": "error", "message": f"{type(e).__name__}: {e}"})
        finally:
            if not saved:  # client went away mid-answer
                save(answer + "\n\n（已停止）")

    return StreamingResponse(gen(), media_type="text/event-stream")


# --------------------------------------------------------------------------- derivation map

def map_context(d, settings):
    """System prompt for map work: the paper (and its LaTeX) when they fit, plus the memory."""
    meta = read_json(d / "meta.json", {})
    pages = read_json(d / "pages.json", [])
    mem = memory.render(d)
    toc = outline(d)
    limit = context_limit(settings)
    budget = limit - len(mem) - len(toc) - 4000
    parts = ["You are a careful research assistant who maps how a paper argues, grounded in its text."]
    if sum(map(len, pages)) <= budget:
        parts.append(f'<paper title="{meta.get("title", "")}">\n{paper_text(pages)}\n</paper>')
        tex = latex_block(d, budget - sum(map(len, pages)))
        if tex:
            parts.append(LATEX_NOTE + "\n" + tex)
    if toc:
        parts.append(toc)
    if mem:
        parts.append(f"Your memory of this paper:\n<paper_memory>\n{mem}\n</paper_memory>")
    return "\n\n".join(parts)


def ground_map(d, tree):
    a = anchors.get(d)
    return mindmap.ground(d, tree, a, lambda page, quote: paper_tools.locate_quote(d, page, quote))


@app.get("/api/papers/{pid}/mindmap")
def get_mindmap(pid: str):
    return {"map": mindmap.load(pdir(pid))}


@app.put("/api/papers/{pid}/mindmap")
async def put_mindmap(pid: str, req: Request):
    d = pdir(pid)
    body = await req.json()
    old = mindmap.load(d) or {}
    mindmap.save(d, {"root": body["root"], "deps": body.get("deps", []), "source": old.get("source", {}), "edited": True})
    return {"ok": True}


@app.post("/api/papers/{pid}/mindmap/generate")
async def generate_mindmap(pid: str):
    d = pdir(pid)
    settings = load_settings()
    name = settings["backend"]
    backend, cfg = BACKENDS[name], settings["backends"].get(name, {})

    async def gen():
        try:
            yield sse({"type": "progress", "nodes": 0})
            system = await asyncio.to_thread(map_context, d, settings)
            prompt = mindmap.PROMPT.format(language=settings["language"])
            out = ""
            async for chunk in backend(system, [{"role": "user", "content": [{"type": "text", "text": prompt}]}], cfg):
                if isinstance(chunk, str):
                    out += chunk
                    yield sse({"type": "progress", "nodes": len(re.findall(r"^\s*[-*]\s+(?:n\d+\s*)?\[", out, re.M))})
                elif "status" in chunk:
                    yield sse({"type": "progress", "nodes": 0, "status": chunk["status"]})
            data = mindmap.parse(out)
            if not data["root"]["children"]:
                raise BackendError("模型没有按格式输出导图，再试一次。")
            await asyncio.to_thread(ground_map, d, data["root"])
            data.update(source=source_of(settings), edited=False)
            mindmap.save(d, data)
            yield sse({"type": "done", "map": mindmap.load(d)})
        except BackendError as e:
            yield sse({"type": "error", "message": str(e)})
        except Exception as e:
            yield sse({"type": "error", "message": f"{type(e).__name__}: {e}"})

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/api/papers/{pid}/mindmap/expand")
async def expand_mindmap(pid: str, req: Request):
    d = pdir(pid)
    body = await req.json()
    settings = load_settings()
    name = settings["backend"]
    path = [n.get("text", "") for n in body.get("path", [])]
    node = body["node"]
    prompt = mindmap.EXPAND_PROMPT.format(path=" → ".join(path) or "(root)", text=node.get("text", ""),
                                          refs=" ".join("@" + r for r in node.get("refs", [])), language=settings["language"])
    system = await asyncio.to_thread(map_context, d, settings)
    try:
        out = await collect(BACKENDS[name], system, [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
                            settings["backends"].get(name, {}))
    except BackendError as e:
        raise HTTPException(502, str(e))
    kids = mindmap.parse_items(out)
    holder = {"id": "x", "children": kids}
    await asyncio.to_thread(ground_map, d, holder)
    return {"children": kids}


@app.post("/api/papers/{pid}/export")
async def export_file(pid: str, req: Request):
    """Save an export to ~/Downloads (works the same in a browser and in the Mac app)."""
    d = pdir(pid)
    body = await req.json()
    kind = body.get("kind")
    meta = read_json(d / "meta.json", {})
    stem = re.sub(r'[\\/:*?"<>|\n]+', " ", meta.get("title", "paper"))[:60].strip() or "paper"
    out_dir = Path.home() / "Downloads"
    out_dir.mkdir(exist_ok=True)
    if kind == "png":
        data, ext = base64.b64decode(body["data"].split(",", 1)[-1]), "png"
    elif kind in ("md", "opml"):
        m = mindmap.load(d)
        if not m:
            raise HTTPException(404, "还没有推导图")
        data = (mindmap.to_markdown(m) if kind == "md" else mindmap.to_opml(m)).encode()
        ext = kind
    else:
        raise HTTPException(400, "unknown export kind")
    path = out_dir / f"{stem} 推导图.{ext}"
    k = 2
    while path.exists():
        path = out_dir / f"{stem} 推导图 {k}.{ext}"
        k += 1
    path.write_bytes(data)
    return {"path": str(path)}


@app.delete("/api/papers/{pid}/threads/{tid}")
def delete_thread(pid: str, tid: str):
    d = pdir(pid)
    DELETED_THREADS.add(tid)
    with memory.lock(d):
        threads = [t for t in read_json(d / "threads.json", []) if t["id"] != tid]
        write_json(d / "threads.json", threads)
        memory.save_qa_entry(d, tid, None)
    for crop in (d / "crops").glob(f"{tid}*.png"):
        crop.unlink()
    return {"ok": True}


@app.delete("/api/papers/{pid}/memory/qa/{tid}")
def forget_qa(pid: str, tid: str):
    d = pdir(pid)
    with memory.lock(d):
        memory.save_qa_entry(d, tid, None)
        threads = read_json(d / "threads.json", [])
        for t in threads:
            if t["id"] == tid:
                t["forgotten"] = True  # a later distill of this thread must not add it back
        write_json(d / "threads.json", threads)
    return {"ok": True}


def upgrade_texts():
    """Papers imported before TEXT_VERSION 2 had two-column lines interleaved; re-extract them once."""
    for d in PAPERS.iterdir():
        meta = read_json(d / "meta.json", None)
        if not meta or meta.get("text_v") == TEXT_VERSION or not (d / "paper.pdf").exists():
            continue
        try:
            pages = page_texts(fitz.open(d / "paper.pdf"))
        except Exception:
            continue
        write_json(d / "pages.json", pages)
        (d / "anchors.json").unlink(missing_ok=True)
        update_meta(d, text_v=TEXT_VERSION, chars=sum(map(len, pages)))


upgrade_texts()

app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


if __name__ == "__main__":
    import threading
    import uvicorn
    port = int(os.environ.get("PORT", 8765))
    if os.environ.get("INTERPRETABILITY_LIFELINE") == "1":
        # Started by the Mac app: exit when the app goes away (quit, crash or force quit closes our stdin).
        import signal

        def watch():
            sys.stdin.buffer.read()
            os.kill(os.getpid(), signal.SIGTERM)
        threading.Thread(target=watch, daemon=True).start()
    if "--no-browser" not in sys.argv:
        threading.Timer(1.2, lambda: webbrowser.open(f"http://127.0.0.1:{port}")).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
