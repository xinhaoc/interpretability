"""LaTeX source for arXiv papers.

PDF text extraction garbles math. For arXiv papers the authors' LaTeX is available, so the
first read (and 全文 mode) gets the exact equations and symbol definitions from it, while
page numbers still come from the PDF text.

The e-print archive is read in memory only; nothing from it is extracted to disk except
the flattened source saved as papers/<id>/latex.tex.
"""
import gzip
import io
import re
import tarfile
from pathlib import Path

import httpx

MAX_CHARS = 300_000
ID_RE = re.compile(r"(\d{4}\.\d{4,5})(v\d+)?")


def arxiv_id(meta, pages):
    m = ID_RE.search(meta.get("source", "")) if "arxiv" in meta.get("source", "") else None
    if not m and pages:
        # Only arXiv's own margin stamp ("arXiv:2401.12345v2 [cs.CL] ..."), not a cited arXiv id.
        m = re.search(r"arXiv:\s*(\d{4}\.\d{4,5})(v\d+)\s*\[", pages[0])
    return (m.group(1) + (m.group(2) or "")) if m else None


def _files(blob: bytes) -> dict[str, str]:
    """{path: text} for the .tex / .bbl files in an e-print (tar.gz, or a single gzipped .tex)."""
    out = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:*") as tar:
            for m in tar.getmembers():
                if m.isfile() and m.name.endswith((".tex", ".bbl")) and m.size < 5_000_000:
                    out[m.name.lstrip("./")] = tar.extractfile(m).read().decode("utf-8", "replace")
        return out
    except tarfile.TarError:
        pass
    try:
        data = gzip.decompress(blob)
    except OSError:
        data = blob
    if data.startswith(b"%PDF"):
        return {}
    return {"main.tex": data.decode("utf-8", "replace")}


def _strip_comments(text):
    return re.sub(r"(?<!\\)%.*", "", text)


def flatten(files: dict[str, str]) -> str:
    mains = [n for n, t in files.items() if n.endswith(".tex") and "\\documentclass" in t and "\\begin{document}" in t]
    if not mains:
        return ""
    main = sorted(mains, key=lambda n: (n.count("/"), -len(files[n])))[0]
    base = str(Path(main).parent)

    def resolve(name):
        name = name.strip()
        for cand in (name, name + ".tex"):
            for path in (cand, str(Path(base) / cand) if base != "." else cand):
                if path in files:
                    return path
        return None

    def expand(text, depth=0):
        text = _strip_comments(text)
        if depth > 8:
            return text

        def sub(m):
            path = resolve(m.group(2))
            return expand(files[path], depth + 1) if path else ""
        return re.sub(r"\\(input|include)\{([^}]+)\}", sub, text)

    full = expand(files[main])
    pre, _, rest = full.partition("\\begin{document}")
    body = rest.split("\\end{document}")[0]
    # Keep only the author's macro definitions from the preamble: they say what symbols mean.
    macros = "\n".join(ln for ln in pre.splitlines()
                       if re.match(r"\s*\\(newcommand|renewcommand|providecommand|def|DeclareMathOperator)\b", ln))
    bbl = next((t for n, t in files.items() if n.endswith(".bbl")), "")
    if bbl and "\\bibliography{" in body:
        body = re.sub(r"\\bibliography\{[^}]*\}", lambda _: _strip_comments(bbl), body)
    text = (macros + "\n\n" + body).strip()
    return re.sub(r"\n{3,}", "\n\n", text)[:MAX_CHARS]


async def ensure(paper_dir: Path, meta, pages) -> str:
    """The flattened LaTeX for an arXiv paper, downloading it once. Empty if unavailable."""
    path = paper_dir / "latex.tex"
    if path.exists():
        return path.read_text()
    if meta.get("latex") == "none":
        return ""
    aid = arxiv_id(meta, pages)
    text = ""
    if aid:
        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=60,
                                         headers={"User-Agent": "Mozilla/5.0 interpretability"}) as c:
                r = await c.get(f"https://arxiv.org/e-print/{aid}")
            if r.status_code != 200 and r.status_code != 404:
                return ""  # rate limited or temporarily unavailable: try again next time
            if r.status_code == 200:
                text = flatten(_files(r.content))
        except Exception:
            return ""  # network trouble or a broken archive: LaTeX is optional, never fail the read
    if text:
        path.write_text(text)
    meta["latex"] = "yes" if text else "none"
    return text
