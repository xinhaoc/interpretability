"""Per-paper memory, owned by the app and independent of any model.

papers/<id>/memory/
    notes.md       reading notes from the first full read
    figures.json   every figure and table: page, box, caption, and a description written by a
                   vision model that looked at the page once (so text-only models can use it too)
    qa.json        what was learned in each Q&A thread, keyed by thread id
    my_notes.md    the reader's own notes (free-form Markdown)
    annotations.json  the reader's highlights and margin notes on the page
    notes.ai.md    a newer AI read, kept aside when the reader has edited notes.md
    info.json      provenance: which backend/model wrote each part, and when

Everything is plain text / JSON, so any backend can read it and you can edit it by hand.
"""
import json
import re
import threading
import time
import uuid
from pathlib import Path

_LOCKS: dict[str, threading.RLock] = {}
_LOCKS_GUARD = threading.Lock()


def lock(paper_dir) -> threading.RLock:
    """One lock per paper, held around every read-modify-write of its JSON files."""
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(str(paper_dir), threading.RLock())


def mdir(paper_dir: Path) -> Path:
    d = paper_dir / "memory"
    if not d.exists():
        with lock(paper_dir):
            d.mkdir(exist_ok=True)
            old = paper_dir / "notes.md"  # layout before memory/ existed
            if old.exists() and not (d / "notes.md").exists():
                old.rename(d / "notes.md")
    return d


def _read_json(p: Path, default):
    return json.loads(p.read_text()) if p.exists() else default


def _write_json(p: Path, obj):
    tmp = p.with_name(f".{p.name}.{uuid.uuid4().hex}.tmp")  # unique, so parallel writers never collide
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1))
    tmp.replace(p)


def notes(paper_dir):
    p = mdir(paper_dir) / "notes.md"
    return p.read_text() if p.exists() else ""


def save_notes(paper_dir, text, source):
    """A new AI read. If the reader edited the notes, keep their version and put the new one aside."""
    if info(paper_dir).get("notes", {}).get("edited"):
        (mdir(paper_dir) / "notes.ai.md").write_text(text)
        set_info(paper_dir, "notes_new", source)
        return
    (mdir(paper_dir) / "notes.md").write_text(text)
    set_info(paper_dir, "notes", source)


def edit_notes(paper_dir, text):
    (mdir(paper_dir) / "notes.md").write_text(text)
    data = info(paper_dir).get("notes", {})
    set_info(paper_dir, "notes", {**{k: v for k, v in data.items() if k != "time"}, "edited": True})


def new_notes(paper_dir):
    p = mdir(paper_dir) / "notes.ai.md"
    return p.read_text() if p.exists() else ""


def accept_new_notes(paper_dir):
    """Switch to the newer AI read; the reader's edited version is kept as a backup file."""
    d = mdir(paper_dir)
    if not (d / "notes.ai.md").exists():
        return
    if (d / "notes.md").exists():
        (d / "notes.md").replace(d / f"notes.edited.{int(time.time())}.md")
    (d / "notes.ai.md").replace(d / "notes.md")
    data = info(paper_dir)
    data["notes"] = data.pop("notes_new", {"time": time.time()})
    _write_json(d / "info.json", data)


def drop_new_notes(paper_dir):
    p = mdir(paper_dir) / "notes.ai.md"
    if p.exists():
        p.unlink()
    data = info(paper_dir)
    data.pop("notes_new", None)
    _write_json(mdir(paper_dir) / "info.json", data)


def my_notes(paper_dir):
    p = mdir(paper_dir) / "my_notes.md"
    return p.read_text() if p.exists() else ""


def save_my_notes(paper_dir, text):
    (mdir(paper_dir) / "my_notes.md").write_text(text)


def annotations(paper_dir):
    return _read_json(mdir(paper_dir) / "annotations.json", [])


def save_annotations(paper_dir, items):
    _write_json(mdir(paper_dir) / "annotations.json", items)


def figures(paper_dir):
    return _read_json(mdir(paper_dir) / "figures.json", [])


def save_figures(paper_dir, figs, source):
    _write_json(mdir(paper_dir) / "figures.json", figs)
    set_info(paper_dir, "figures", source)


def qa(paper_dir):
    return _read_json(mdir(paper_dir) / "qa.json", {})


def save_qa_entry(paper_dir, thread_id, entry):
    with lock(paper_dir):
        p = mdir(paper_dir) / "qa.json"
        data = _read_json(p, {})
        if entry is None:
            data.pop(thread_id, None)
        else:
            data[thread_id] = entry
        _write_json(p, data)


def info(paper_dir):
    return _read_json(mdir(paper_dir) / "info.json", {})


def set_info(paper_dir, part, source):
    with lock(paper_dir):
        p = mdir(paper_dir) / "info.json"
        data = _read_json(p, {})
        data[part] = {**source, "time": time.time()}
        _write_json(p, data)


def has_memory(paper_dir):
    return bool(notes(paper_dir).strip())


def render(paper_dir) -> str:
    """Memory as one text block for the model. Most stable parts first, for prompt caching."""
    parts = []
    n = notes(paper_dir).strip()
    if n:
        parts.append(f"<reading_notes>\n{n}\n</reading_notes>")
    figs = figures(paper_dir)
    if figs:
        lines = []
        for f in figs:
            box = f.get("bbox")
            where = f"p.{f['page']}" + (f", box x0={box[0]:.2f} y0={box[1]:.2f} x1={box[2]:.2f} y1={box[3]:.2f}" if box else "")
            desc = f.get("description") or "(not described yet)"
            lines.append(f"### {f['label']} [{where}]\nCaption: {f.get('caption', '')}\n{desc}")
        parts.append("<figures_and_tables>\n" + "\n\n".join(lines) + "\n</figures_and_tables>")
    return "\n\n".join(parts)


def render_reader(paper_dir) -> str:
    """The reader's own notes and margin notes, for the model."""
    parts = []
    mine = my_notes(paper_dir).strip()
    if mine:
        parts.append(f"<reader_notes>\n{mine}\n</reader_notes>")
    notes_on_page = [a for a in annotations(paper_dir) if a.get("note", "").strip()]
    if notes_on_page:
        lines = []
        for a in sorted(notes_on_page, key=lambda a: (a["page"], a["bbox"][1])):
            what = f"“{a['text'][:200]}”" if a.get("text") else "a marked region"
            lines.append(f"- [p.{a['page'] + 1}] on {what}: {a['note'].strip()}")
        parts.append("<reader_margin_notes>\n" + "\n".join(lines) + "\n</reader_margin_notes>")
    mm = mdir(paper_dir) / "mindmap.json"
    if mm.exists():
        data = json.loads(mm.read_text())
        if data.get("edited"):
            import mindmap
            parts.append("<reader_derivation_map>\n" + mindmap.render_text(data) + "\n</reader_derivation_map>")
    if not parts:
        return ""
    return ("The reader's own notes on this paper. Build on the reader's understanding, refer back to it when relevant, "
            "and say so plainly if something in it is wrong.\n" + "\n".join(parts))


def render_qa(paper_dir) -> str:
    entries = sorted(qa(paper_dir).values(), key=lambda e: e.get("time", 0))
    if not entries:
        return ""
    blocks = []
    for e in entries:
        where = f"p.{e['page']}" if e.get("page") else "whole paper"
        blocks.append(f"- [{where}] Reader asked: {e.get('question', '')}\n{e['facts'].strip()}")
    return "<earlier_questions>\nWhat came out of the reader's earlier questions about this paper:\n" + "\n".join(blocks) + "\n</earlier_questions>"


# --------------------------------------------------------------------------- figure pass

CAPTION_RE = re.compile(r"^\s*((?:Figure|Fig\.|Table)\s*(\d+))\s*[\.:|]\s*(.*)", re.I)


def find_captions(pages):
    """[(page_index, label, caption_text)] for every 'Figure N:' / 'Table N:' caption line."""
    seen, out = set(), []
    for i, text in enumerate(pages):
        lines = text.splitlines()
        for j, ln in enumerate(lines):
            m = CAPTION_RE.match(ln)
            if not m:
                continue
            kind = "Table" if m.group(1).lower().startswith("tab") else "Figure"
            label = f"{kind} {m.group(2)}"
            if label in seen:
                continue  # later mentions in the text, not the caption
            seen.add(label)
            cap = m.group(3)
            for extra in lines[j + 1:j + 4]:  # captions wrap over a few lines
                if not extra.strip() or CAPTION_RE.match(extra):
                    break
                cap += " " + extra.strip()
            out.append((i, label, cap.strip()[:600]))
    return out


FIGURE_PROMPT = """These are page images from the paper. They contain these figures/tables (found from their captions):

{items}

For EACH item, look at it and write a description that lets someone who cannot see the image understand it:
- what kind of plot/diagram/table it is, and what each axis / column / box / arrow means;
- the key content: trends, the important numbers (for tables, the rows and values that matter), components and how they connect;
- the takeaway, and which claim in the paper it supports.
3-8 sentences each, in {language}. Read numbers off the image; do not invent values you cannot read. Text next to a figure may belong to a neighbouring figure, so describe only the item named. If an item is not on these pages or is unreadable, write NOT FOUND as its description. Also give its bounding box on the page as fractions (0-1, origin top-left), including the caption.

Use exactly this format, one block per item, nothing else:

=== Figure 1 | page 3 | bbox 0.30 0.10 0.70 0.60
<description>

=== Table 2 | page 8 | bbox 0.18 0.10 0.85 0.37
<description>"""

BLOCK_RE = re.compile(r"^===\s*(.+?)\s*\|\s*page\s*(\d+)\s*\|\s*bbox\s*([\d.\s,]+?)\s*$", re.M | re.I)


def parse_figure_blocks(text):
    """[{label, page, bbox, description}] from the === delimited format."""
    out = []
    heads = list(BLOCK_RE.finditer(text))
    for k, m in enumerate(heads):
        end = heads[k + 1].start() if k + 1 < len(heads) else len(text)
        nums = [float(v) for v in re.findall(r"\d*\.?\d+", m.group(3))]
        out.append({"label": m.group(1).strip(), "page": int(m.group(2)),
                    "bbox": nums[:4] if len(nums) >= 4 else None,
                    "description": text[m.end():end].strip().strip("`").strip()})
    return out


# --------------------------------------------------------------------------- Q&A distillation

DISTILL_PROMPT = """Below is a Q&A exchange between a reader and an assistant about this paper. Extract what is worth remembering for answering the reader's future questions about the paper:
- facts or derivations that were worked out and are not already obvious from the paper,
- corrections or additions to the reading notes,
- what the reader found confusing (so later answers can build on it).

Write 1-4 short bullets in {language}, each self-contained. End each bullet with its evidence: either a short exact quote from the paper in curly quotes followed by its page, like “...” [p.N], or the tag 「推断」 (use "(inference)" when writing in English) if it was worked out in the conversation rather than stated in the paper. Leave out anything the exchange shows to be wrong. If nothing new is worth keeping, reply exactly NONE.

<exchange>
{exchange}
</exchange>"""
