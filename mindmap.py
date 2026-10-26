"""Derivation map: how a paper's argument goes from the problem to its conclusions.

The model writes the map as an indented list (easier for models to get right than JSON,
and unaffected by quote characters in the text). Every node carries where it comes from
(@Figure N, @Eq. (N), @§N.N, @p.N) and optionally an exact quote, which is checked
against the PDF. The map is stored in the paper's memory as memory/mindmap.json.
"""
import json
import re
import time
import uuid
from pathlib import Path

import memory

SECTIONS = [  # (header the model writes, branch kind, label shown)
    ("PROBLEM", "problem", "问题与动机"),
    ("IDEA", "idea", "关键想法"),
    ("METHOD", "method", "方法推导"),
    ("EVIDENCE", "evidence", "实验证据"),
    ("LIMITS", "limitation", "局限"),
]
KINDS = {"problem", "idea", "assumption", "method", "equation", "evidence", "result", "limitation"}

PROMPT = """Make a derivation map of this paper: how its argument goes, step by step, from the problem to the conclusions. The reader will use it as an editable mind map next to the PDF, and click each node to jump to where it comes from.

Output plain text in exactly this format, nothing else:

ROOT: <the paper's core claim in one sentence>
## PROBLEM
- n1 [problem] <node text> @p.2
  - n2 [assumption] <node text> @§2 “short exact quote from the paper”
## IDEA
- n3 [idea] ...
## METHOD
- n4 [method] ...
  - n5 [equation] <what it computes> $<the equation in LaTeX>$ @Eq. (1)
## EVIDENCE
- n9 [evidence] <experiment and its numbers> @Table 2
## LIMITS
- n12 [limitation] ...
DEPS:
n5 -> n9: <short label>

Rules:
- Sections in this order: PROBLEM (the gap and why it matters), IDEA (the key insight), METHOD (how it works, as a chain of steps; give each important equation its own [equation] node, in derivation order, with the equation in LaTeX), EVIDENCE (the experiments behind each claim, with the actual numbers), LIMITS (assumptions, weaknesses, open questions).
- Kinds: problem, idea, assumption, method, equation, evidence, result, limitation.
- Children are indented by two spaces; at most 3 levels inside a section; 25-45 nodes in total.
- Node text: one short statement in {language} (about 40 characters at most, plus LaTeX when needed). No paragraphs.
- Ground every node: end it with where it comes from, using @Figure N, @Table N, @Eq. (N), @§N.N or @p.N (several are fine). When a node rests on specific wording, add a short exact quote from the paper (5-20 words, copied in the paper's own language) in curly quotes “...”.
- DEPS lists links that cross branches (an equation that follows from an assumption, an experiment that supports an idea, a limitation of a method step), at most 12, using node ids, with a 2-6 character label in {language}."""

EXPAND_PROMPT = """In the derivation map of this paper, the reader wants more detail under this node:

Path from the root: {path}
Node: {text} {refs}

Write 2-5 child nodes that explain how this point is derived or supported: the sub-steps, the equations involved, the evidence. Use the same item format as the map, one per line, no indentation:
- [kind] <short statement in {language}, about 40 characters at most> @<where it comes from> “optional short exact quote”

Kinds: problem, idea, assumption, method, equation, evidence, result, limitation. Put equations in LaTeX $...$. Output only the lines."""

REF_BODY = r"(?:Figure|Fig\.|Table)\s*\d+|Eq\.?\s*\(\s*\d+[a-z]?\s*\)|§\s*[\dA-Z]+(?:\.\d+)*|p\.\s*\d+(?:\s*[-–]\s*\d+)?"
REF_RE = re.compile(rf"@\s*({REF_BODY})", re.I)
# Refs the model wrote at the end of a node without the @ (e.g. "… p.7-8", "… Table1").
TRAILING_RE = re.compile(rf"(?:[\s,，;；]*(?:{REF_BODY}|row\s*\(\w\)|脚注))+\s*$", re.I)
QUOTE_RE = re.compile(r"[“\"]([^”\"]{6,300})[”\"]")
ITEM_RE = re.compile(r"^(\s*)[-*]\s+(?:(n\d+)\s*)?\[(\w+)\]\s*(.+)$")


def _norm_ref(r):
    r = re.sub(r"\s+", " ", r).strip().replace("Fig.", "Figure")
    r = re.sub(r"^(Figure|Table)\s*(\d+)$", r"\1 \2", r, flags=re.I)
    r = re.sub(r"^Eq\.?\s*\(\s*(\w+)\s*\)$", r"Eq. (\1)", r)
    r = re.sub(r"^§\s*", "§", r)
    return re.sub(r"^p\.\s*", "p.", r)


def _node(text, kind, nid=None):
    refs = [_norm_ref(r) for r in REF_RE.findall(text)]
    quote_m = QUOTE_RE.search(text)
    clean = QUOTE_RE.sub("", REF_RE.sub("", text)).strip(" -—:;，,")
    if m := TRAILING_RE.search(clean):
        tail = m.group(0)
        bare = re.findall(REF_BODY, tail, re.I)
        if bare and len(clean) - len(tail) > 4:  # keep the statement itself
            refs += [_norm_ref(r) for r in bare]
            clean = clean[: m.start()].strip(" -—:;，,")
    refs = list(dict.fromkeys(refs))
    return {"id": nid or "m" + uuid.uuid4().hex[:8], "text": clean, "kind": kind if kind in KINDS else "method",
            "refs": refs, "quote": quote_m.group(1).strip() if quote_m else "", "children": []}


def parse(text):
    """The model's indented list -> {root, deps}. Lenient: unknown lines are skipped."""
    root = {"id": "root", "text": "", "kind": "root", "refs": [], "quote": "", "children": []}
    branches = {}
    for header, kind, label in SECTIONS:
        branches[header] = {"id": "b-" + kind, "text": label, "kind": "branch", "refs": [], "quote": "", "children": []}
    deps, current, stack, in_deps = [], None, [], False
    ids = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        if m := re.match(r"^\s*ROOT:\s*(.+)$", line):
            r = _node(m.group(1), "root", "root")
            root.update(text=r["text"], refs=r["refs"], quote=r["quote"])
            continue
        if m := re.match(r"^\s*#+\s*([A-Z]+)", line):
            current = branches.get(m.group(1).upper())
            stack, in_deps = [], False
            continue
        if re.match(r"^\s*DEPS:?\s*$", line, re.I):
            in_deps = True
            continue
        if in_deps:
            if m := re.match(r"^\s*(n\d+)\s*-+>\s*(n\d+)\s*:?\s*(.*)$", line):
                deps.append({"from": m.group(1), "to": m.group(2), "label": m.group(3).strip()[:12]})
            continue
        if current is None or not (m := ITEM_RE.match(line)):
            continue
        indent, nid, kind, body = len(m.group(1).expandtabs(2)), m.group(2), m.group(3).lower(), m.group(4)
        if nid in ids:  # ids must be unique for the editor
            nid = None
        node = _node(body, kind, nid)
        if nid:
            ids[nid] = node["id"]
        while stack and stack[-1][0] >= indent:
            stack.pop()
        (stack[-1][1]["children"] if stack else current["children"]).append(node)
        stack.append((indent, node))
    root["children"] = [b for b in branches.values() if b["children"]]
    deps = [d for d in deps if d["from"] in ids and d["to"] in ids and d["from"] != d["to"]]
    return {"root": root, "deps": deps}


def parse_items(text):
    """Lines of '- [kind] text @ref “quote”' (used for expanding a node)."""
    out = []
    for line in text.splitlines():
        if m := ITEM_RE.match(line):
            out.append(_node(m.group(4), m.group(3).lower()))
    return out


def walk(node):
    yield node
    for c in node.get("children", []):
        yield from walk(c)


def ground(paper_dir: Path, tree, anchors_data, locate):
    """Give every node a page (from its refs) and check its quote against the PDF."""
    A = anchors_data or {}

    def page_of(ref):
        if m := re.match(r"p\.\s*(\d+)", ref):  # first page of a range
            return int(m.group(1))
        if m := re.match(r"(Figure|Table)\s*(\d+)", ref):
            hit = A.get("figures", {}).get(f"{m.group(1)} {m.group(2)}")
            return hit and hit["page"]
        if m := re.match(r"Eq\.?\s*\(\s*(\w+)\s*\)", ref):
            hit = A.get("equations", {}).get(m.group(1))
            return hit and hit["page"]
        if m := re.match(r"§\s*([\w.]+)", ref):
            hit = A.get("sections", {}).get(m.group(1))
            return hit and hit["page"]
        return None

    for node in walk(tree):
        pages = [p for p in (page_of(r) for r in node.get("refs", [])) if p]
        node["page"] = pages[0] if pages else node.get("page")
        if node.get("quote"):
            try:
                r = locate(node["page"] or 1, node["quote"])
            except Exception:
                r = {"verified": False}
            node["verified"] = bool(r.get("verified"))
            if r.get("verified"):
                node["page"] = r["page"]
                node["spans"] = r.get("spans")
    return tree


def path_to(tree, nid):
    if tree["id"] == nid:
        return [tree]
    for c in tree.get("children", []):
        if p := path_to(c, nid):
            return [tree] + p
    return None


def load(paper_dir):
    p = memory.mdir(paper_dir) / "mindmap.json"
    return json.loads(p.read_text()) if p.exists() else None


def save(paper_dir, data):
    with memory.lock(paper_dir):
        memory._write_json(memory.mdir(paper_dir) / "mindmap.json", {**data, "time": time.time()})


def to_markdown(data):
    lines = [f"# {data['root']['text']}", ""]

    def rec(node, depth):
        refs = " ".join(node.get("refs", []))
        q = f" “{node['quote']}”" if node.get("quote") else ""
        lines.append(f"{'  ' * depth}- {node['text']}{(' (' + refs + ')') if refs else ''}{q}")
        for c in node.get("children", []):
            rec(c, depth + 1)
    for c in data["root"].get("children", []):
        rec(c, 0)
    if data.get("deps"):
        names = {n["id"]: n["text"] for n in walk(data["root"])}
        lines += ["", "## 依赖关系", ""]
        lines += [f"- {names.get(d['from'], d['from'])} → {names.get(d['to'], d['to'])}：{d.get('label', '')}" for d in data["deps"]]
    return "\n".join(lines) + "\n"


def to_opml(data):
    from xml.sax.saxutils import quoteattr

    def rec(node):
        text = node["text"] + (" (" + " ".join(node["refs"]) + ")" if node.get("refs") else "")
        kids = "".join(rec(c) for c in node.get("children", []))
        return f"<outline text={quoteattr(text)}>{kids}</outline>"
    title = quoteattr(data["root"]["text"])
    return (f'<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>{title[1:-1]}</title></head>'
            f"<body>{rec(data['root'])}</body></opml>\n")


def render_text(data):
    """Compact outline for the model's context (only used when the reader edited the map)."""
    out = []

    def rec(node, depth):
        refs = (" [" + ", ".join(node["refs"]) + "]") if node.get("refs") else ""
        out.append(f"{'  ' * depth}- {node['text']}{refs}")
        for c in node.get("children", []):
            rec(c, depth + 1)
    rec(data["root"], 0)
    return "\n".join(out)
