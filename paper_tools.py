"""Tools the model can call while answering: search the paper text, look at a page region.

Used three ways: by the Anthropic API tool loop, by the MCP server that Claude Code
talks to (mcp_server.py), and by the harness itself for backends without tool use.
"""
import json
import re
from pathlib import Path

import fitz  # PyMuPDF

TOOL_SPECS = [
    {
        "name": "search_paper",
        "description": (
            "Search the full text of the paper. Use it to check exact wording, numbers, hyperparameters, "
            "where a symbol or term is defined, or anything the memory does not cover. "
            "Returns matching lines with page numbers and a little surrounding text. "
            "Query in the paper's language (usually English); short keyword queries work best."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Keywords or a short phrase, e.g. 'label smoothing' or 'd_k'."},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "read_pages",
        "description": (
            "Read the full extracted text of one or more consecutive pages (at most 4). Use it to read a whole "
            "section, e.g. after finding it in the outline. Math and tables may be garbled in extracted text."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "start": {"type": "integer", "description": "First page, 1-based."},
                "end": {"type": "integer", "description": "Last page, 1-based (inclusive). Defaults to start."},
            },
            "required": ["start"],
            "additionalProperties": False,
        },
    },
    {
        "name": "view_page",
        "description": (
            "Look at an image of a page, or part of a page. Use it for figures, tables and equations, "
            "whose extracted text is unreliable. Coordinates are fractions of the page (0-1, origin top-left); "
            "omit them to see the whole page."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "page": {"type": "integer", "description": "1-based page number."},
                "x0": {"type": "number"}, "y0": {"type": "number"},
                "x1": {"type": "number"}, "y1": {"type": "number"},
            },
            "required": ["page"],
            "additionalProperties": False,
        },
    },
]


def _pages(paper_dir: Path):
    return json.loads((paper_dir / "pages.json").read_text())


def search_paper(paper_dir: Path, query: str, max_hits: int = 8, context_lines: int = 2) -> str:
    pages = _pages(paper_dir)
    terms = [t.lower() for t in re.findall(r"[\w\-\.\\^{}]+", query) if len(t) > 1] or [query.lower()]
    phrase = query.lower().strip()
    hits = []
    for pno, text in enumerate(pages):
        lines = text.splitlines()
        low = [ln.lower() for ln in lines]
        for i, ln in enumerate(low):
            # Match within a 2-line window so phrases broken across lines still hit.
            window = ln + " " + (low[i + 1] if i + 1 < len(low) else "")
            n = sum(t in window for t in terms)
            if n == 0:
                continue
            score = n / len(terms) + (1.0 if phrase in window else 0.0)
            hits.append((score, pno, i, lines))
    if not hits:
        return f'No matches for "{query}".'
    hits.sort(key=lambda h: (-h[0], h[1], h[2]))
    best = hits[0][0]
    out, used = [], set()
    for score, pno, i, lines in hits:
        if score < best * 0.5 or len(out) >= max_hits:
            break
        if any(p == pno and abs(j - i) <= context_lines for p, j in used):
            continue
        used.add((pno, i))
        a, b = max(0, i - context_lines), min(len(lines), i + context_lines + 2)
        out.append(f"[p.{pno + 1}]\n" + "\n".join(lines[a:b]))
    return f'{len(out)} match(es) for "{query}":\n\n' + "\n\n".join(out)


def read_pages(paper_dir: Path, start: int, end: int | None = None) -> str:
    pages = _pages(paper_dir)
    start = max(1, min(len(pages), int(start)))
    end = max(start, min(len(pages), int(end or start), start + 3))
    return "\n\n".join(f'<page n="{i}">\n{pages[i - 1]}\n</page>' for i in range(start, end + 1))


def view_page(paper_dir: Path, page: int, x0=0.0, y0=0.0, x1=1.0, y1=1.0, max_px=1400) -> bytes:
    """PNG bytes of the region of a 1-based page."""
    doc = fitz.open(paper_dir / "paper.pdf")
    if not 1 <= page <= len(doc):
        raise ValueError(f"page must be 1..{len(doc)}")
    p = doc[page - 1]
    W, H = p.rect.width, p.rect.height
    x0, x1 = sorted((max(0.0, min(1.0, x0)), max(0.0, min(1.0, x1))))
    y0, y1 = sorted((max(0.0, min(1.0, y0)), max(0.0, min(1.0, y1))))
    if x1 - x0 < 0.02 or y1 - y0 < 0.02:
        x0, y0, x1, y1 = 0.0, 0.0, 1.0, 1.0
    clip = fitz.Rect(x0 * W, y0 * H, x1 * W, y1 * H)
    zoom = min(4.0, max_px / max(clip.width, clip.height * 0.75))
    pix = p.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=clip, alpha=False)
    return pix.tobytes("png")


def page_count(paper_dir: Path) -> int:
    return len(_pages(paper_dir))


def describe_call(name: str, args: dict) -> str:
    """Short human-readable label for the UI."""
    if name.endswith("search_paper"):
        return f"搜索原文：{args.get('query', '')}"
    if name.endswith("read_pages"):
        a, b = args.get("start"), args.get("end")
        return f"阅读第 {a} 页" if not b or b == a else f"阅读第 {a}–{b} 页"
    if name.endswith("view_page"):
        part = "" if not any(k in args for k in ("x0", "y0", "x1", "y1")) else " 的局部"
        return f"查看第 {args.get('page')} 页{part}"
    return name


# --------------------------------------------------------------------------- quote checking

def _norm(w):
    return re.sub(r"[^\w]", "", w.lower())


def locate_quote(paper_dir: Path, page: int, quote: str):
    """Find a quote on its page, a neighbouring page (the page number may be off by one),
    or across a page break.

    Matches word by word with a fuzzy score, so line breaks, hyphenation and small
    differences in punctuation do not matter. Returns {verified, page, rects, spans, score};
    spans has one {page, rects} per page the quote covers.
    """
    from difflib import SequenceMatcher
    doc = fitz.open(paper_dir / "paper.pdf")
    q = [_norm(w) for w in quote.split()]
    q = [w for w in q if w]
    if not q:
        return {"verified": False}
    qs, n = " ".join(q), len(q)

    def words_of(pno):
        if not 1 <= pno <= len(doc):
            return []
        return [(pno, w) for w in doc[pno - 1].get_text("words") if _norm(w[4])]

    # Single pages first, then the joins across page breaks (end of one page + start of the next).
    tail = max(n + 2, 40)
    candidates = [words_of(page), words_of(page - 1), words_of(page + 1)]
    for a_, b_ in ((page, page + 1), (page - 1, page)):
        wa, wb = words_of(a_), words_of(b_)
        if wa and wb:
            candidates.append(wa[-tail:] + wb[:tail])

    best = {"score": 0.0}
    for words in candidates:
        if not words:  # blank or scanned page
            continue
        norm = [_norm(w[4]) for _, w in words]
        for i in range(0, max(1, len(words) - n + 1)):
            # cheap prefilter: the window must share its first or last word with the quote
            if norm[i] != q[0] and (i + n - 1 >= len(norm) or norm[i + n - 1] != q[-1]):
                continue
            for m in (n - 1, n, n + 1):
                score = SequenceMatcher(None, " ".join(norm[i:i + m]), qs).ratio()
                if score > best["score"]:
                    best = {"score": score, "hit": words[i:i + m]}
        if best["score"] >= 0.97:
            break
    if best["score"] < 0.85:
        return {"verified": False, "score": round(best["score"], 2)}

    lines = {}  # (page, block, line) -> box
    for pno, w in best["hit"]:
        r = lines.setdefault((pno, w[5], w[6]), [w[0], w[1], w[2], w[3]])
        r[0], r[1], r[2], r[3] = min(r[0], w[0]), min(r[1], w[1]), max(r[2], w[2]), max(r[3], w[3])
    spans = {}
    for (pno, _, _), r in lines.items():
        pg = doc[pno - 1]
        W, H = pg.rect.width, pg.rect.height
        shown = fitz.Rect(r) * pg.rotation_matrix  # word boxes are unrotated; map to the page as displayed
        spans.setdefault(pno, []).append([shown.x0 / W, shown.y0 / H, shown.x1 / W, shown.y1 / H])
    spans = [{"page": p_, "rects": rs} for p_, rs in sorted(spans.items())]
    return {"verified": True, "page": spans[0]["page"], "rects": spans[0]["rects"], "spans": spans,
            "score": round(best["score"], 2)}
