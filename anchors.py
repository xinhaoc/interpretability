"""Where things are in the paper: sections, figures, tables, equations, references.

The UI uses this to turn "Figure 3", "Eq. (2)", "§3.2", "[17]" in answers into links that
jump to the spot and show a preview. Boxes are fractions of the page, origin top-left.
"""
import json
import re
from pathlib import Path

import fitz  # PyMuPDF

import memory

VERSION = 2


def _lines(page):
    for b in page.get_text("dict")["blocks"]:
        for ln in b.get("lines", []):
            text = "".join(s["text"] for s in ln["spans"]).strip()
            if text:
                yield text, fitz.Rect(ln["bbox"])


def _frac(rect, page):
    rect = fitz.Rect(rect) * page.rotation_matrix  # text coordinates are unrotated; the viewer shows the page rotated
    W, H = page.rect.width, page.rect.height
    return [max(0.0, rect.x0 / W), max(0.0, rect.y0 / H), min(1.0, rect.x1 / W), min(1.0, rect.y1 / H)]


def sections(doc):
    out = {}
    counters = []
    for lvl, title, pno, dest in doc.get_toc(simple=False):
        if pno < 1:
            continue
        page = doc[pno - 1]
        H = page.rect.height
        to = dest.get("to") if isinstance(dest, dict) else None
        # TOC destinations are in PDF space (origin bottom-left).
        y = max(0.0, min(1.0, (H - to.y) / H)) if to is not None else 0.0
        # Prefer the number printed in the heading; fall back to counting TOC levels.
        number = None
        head = re.escape(title.strip()[:20])
        for text, r in _lines(page):
            m = re.match(rf"^((?:\d+|[A-Z])(?:\.\d+)*)\.?\s+{head}", text)
            if m:
                number, y = m.group(1), _frac(r, page)[1]  # rotation-aware
                break
        counters = counters[:lvl] + [0] * max(0, lvl - len(counters))
        counters[lvl - 1] += 1
        if number is None and not re.search(r"reference|acknowledg|bibliograph|appendix", title, re.I):
            number = ".".join(map(str, counters[:lvl]))
        entry = {"page": pno, "bbox": [0.0, max(0.0, y - 0.01), 1.0, min(1.0, y + 0.06)], "title": title.strip()}
        if number:
            out.setdefault(number, entry)
        out.setdefault(title.strip().lower(), entry)
    return out


def figures(doc, paper_dir):
    """Figure/table boxes: from the figure pass when it gave one, else around the caption."""
    out = {}
    figs = memory.figures(paper_dir)
    if not figs:
        pages = json.loads((paper_dir / "pages.json").read_text())
        figs = [{"label": label, "page": i + 1, "bbox": None} for i, label, _ in memory.find_captions(pages)]
    for f in figs:
        label, pno = f["label"], f["page"]
        if f.get("bbox"):
            out[label] = {"page": pno, "bbox": f["bbox"]}
            continue
        page = doc[pno - 1]
        H = page.rect.height
        hits = page.search_for(label + ":") or page.search_for(label + ".") or page.search_for(label)
        if not hits:
            out[label] = {"page": pno, "bbox": [0, 0, 1, 0.5]}
            continue
        cap = hits[0]
        if label.startswith("Table"):  # table captions sit above the table
            box = fitz.Rect(0, cap.y0 - 4, page.rect.width, min(H, cap.y1 + 0.3 * H))
        else:
            box = fitz.Rect(0, max(0, cap.y0 - 0.35 * H), page.rect.width, cap.y1 + 4)
        out[label] = {"page": pno, "bbox": _frac(box, page)}
    return out


def equations(doc):
    out = {}
    for pno, page in enumerate(doc):
        W, H = page.rect.width, page.rect.height
        for text, r in _lines(page):
            m = re.fullmatch(r"\((\d+[a-z]?)\)", text)
            if not m or m.group(1) in out or r.x0 < W * 0.3:
                continue
            # The equation sits to the left of its number, in the same column.
            x0 = 0.5 * W if r.x0 > 0.75 * W and r.x0 - 0.5 * W < 0.45 * W and _two_column(page) else 0.04 * W
            box = fitz.Rect(x0, r.y0 - 0.035 * H, r.x1 + 4, r.y1 + 0.02 * H)
            out[m.group(1)] = {"page": pno + 1, "bbox": _frac(box, page)}
    return out


def _two_column(page):
    W = page.rect.width
    starts = [r.x0 for _, r in _lines(page)]
    return sum(1 for x in starts if x > 0.5 * W) > len(starts) * 0.3


def references(doc):
    """Numbered bibliography entries ([1], [2], ...)."""
    out = {}
    start = None
    for pno in range(len(doc) - 1, -1, -1):
        for text, _ in _lines(doc[pno]):
            if re.fullmatch(r"(\d+\.?\s*)?(References|Bibliography|REFERENCES)", text):
                start = pno
                break
        if start is not None:
            break
    if start is None:
        return out
    for pno in range(start, len(doc)):
        page = doc[pno]
        entries = [(m.group(1), r) for text, r in _lines(page) if (m := re.match(r"^\[(\d+)\]", text))]
        W, H = page.rect.width, page.rect.height
        two = _two_column(page)
        for k, (num, r) in enumerate(entries):
            if num in out:
                continue
            same_col = k + 1 < len(entries) and abs(entries[k + 1][1].x0 - r.x0) < 30
            bottom = entries[k + 1][1].y0 - 1 if same_col else r.y1 + 0.05 * H
            right = (0.5 * W - 2 if r.x0 < 0.5 * W else 0.97 * W) if two else 0.95 * W
            box = fitz.Rect(r.x0 - 3, r.y0 - 1, right, max(bottom, r.y1))
            out[num] = {"page": pno + 1, "bbox": _frac(box, page),
                        "text": page.get_text("text", clip=box).strip().replace("\n", " ")[:400]}
    return out


def compute(paper_dir: Path):
    doc = fitz.open(paper_dir / "paper.pdf")
    return {"version": VERSION, "sections": sections(doc), "figures": figures(doc, paper_dir),
            "equations": equations(doc), "references": references(doc)}


def get(paper_dir: Path):
    """Cached; recomputed when the figure memory changes."""
    cache = paper_dir / "anchors.json"
    figs = memory.mdir(paper_dir) / "figures.json"
    if cache.exists():
        data = json.loads(cache.read_text())
        fresh = data.get("version") == VERSION and (not figs.exists() or cache.stat().st_mtime >= figs.stat().st_mtime)
        if fresh:
            return data
    data = compute(paper_dir)
    cache.write_text(json.dumps(data, ensure_ascii=False))
    return data
