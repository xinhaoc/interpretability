"""The word book: words picked while reading, with the sentence they came from, a meaning
written by the model, and a review schedule (Leitner boxes). One file for all papers."""
import json
import re
import threading
import time
import uuid
from pathlib import Path

_LOCK = threading.RLock()

# Days until the next review for each box; a word moves up one box each time you know it.
INTERVALS = [0, 1, 2, 4, 7, 15, 30, 60]
AGAIN_SECONDS = 10 * 60  # a word you did not know comes back in the same session

DEFINE_PROMPT = """The reader is reading the paper "{title}" and marked an English word or phrase they did not know.

Word: {word}
Sentence: {sentence}

Explain it for a {language}-speaking reader. Answer in exactly this format, one field per line, values in {language} except Lemma and IPA:
Lemma: the dictionary form (e.g. "features" -> "feature"; same as the word if it already is)
IPA: the pronunciation in IPA between slashes, e.g. /ˈfiːtʃər/ (leave empty for a multi-word phrase)
POS: part of speech as used here, abbreviated (n. / v. / adj. / adv. / phr.)
In context: what it means in this sentence, in a few words
General: its common meanings, one short line
Note: one short line on usage, a common collocation, or how it differs from a similar word; empty if nothing useful"""

FIELDS = {"lemma": "Lemma", "phonetic": "IPA", "pos": "POS", "meaning": "In context", "general": "General", "note": "Note"}


def _file(data: Path) -> Path:
    return data / "vocab.json"


def load(data: Path) -> list:
    p = _file(data)
    return json.loads(p.read_text()) if p.exists() else []


def _save(data: Path, words: list):
    p = _file(data)
    tmp = p.with_name(f".vocab.{uuid.uuid4().hex}.tmp")
    tmp.write_text(json.dumps(words, ensure_ascii=False, indent=1))
    tmp.replace(p)


def clean_word(w: str) -> str:
    w = " ".join(w.split())
    return re.sub(r"^[^\w]+|[^\w]+$", "", w)


def add(data: Path, word: str, context: dict) -> tuple[dict, bool]:
    """Add a word, or a new context to a word already in the book. Returns (entry, needs_meaning)."""
    word = clean_word(word)
    now = time.time()
    with _LOCK:
        words = load(data)
        key = word.lower()
        e = next((x for x in words if x["word"].lower() == key or (x.get("lemma") or "").lower() == key), None)
        if e:
            if not any(c.get("sentence") == context.get("sentence") for c in e["contexts"]):
                e["contexts"].append({**context, "added": now})
            # Picking a word again means it is still unfamiliar: bring it back for review.
            e["box"], e["due"] = 0, now
        else:
            e = {"id": uuid.uuid4().hex[:10], "word": word, "contexts": [{**context, "added": now}],
                 "added": now, "box": 0, "due": now, "reviews": 0, "lapses": 0, "status": "pending",
                 **{k: "" for k in FIELDS}}
            words.append(e)
        _save(data, words)
        return e, e.get("status") != "ok"


def get(data: Path, wid: str):
    return next((x for x in load(data) if x["id"] == wid), None)


def update(data: Path, wid: str, **fields):
    with _LOCK:
        words = load(data)
        e = next((x for x in words if x["id"] == wid), None)
        if not e:
            return None
        e.update(fields)
        _save(data, words)
        return e


def delete(data: Path, wid: str):
    with _LOCK:
        _save(data, [x for x in load(data) if x["id"] != wid])


def review(data: Path, wid: str, grade: str):
    """grade: again (did not know) / hard (barely) / good (knew it)."""
    with _LOCK:
        words = load(data)
        e = next((x for x in words if x["id"] == wid), None)
        if not e:
            return None
        now = time.time()
        e["reviews"] += 1
        if grade == "again":
            e["box"], e["lapses"], e["due"] = 0, e["lapses"] + 1, now + AGAIN_SECONDS
        elif grade == "hard":
            e["due"] = now + max(1, INTERVALS[e["box"]] / 2) * 86400
        else:
            e["box"] = min(e["box"] + 1, len(INTERVALS) - 1)
            e["due"] = now + INTERVALS[e["box"]] * 86400
        e["last_review"] = now
        _save(data, words)
        return e


def due_count(words, now=None) -> int:
    now = now or time.time()
    return sum(1 for x in words if x["due"] <= now)


def parse_definition(text: str) -> dict:
    out = {}
    names = {v.lower(): k for k, v in FIELDS.items()}
    for line in text.splitlines():
        m = re.match(r"\s*[-*]?\s*\**([A-Za-z ]+?)\**\s*[:：]\s*(.*)$", line)
        if m and m.group(1).strip().lower() in names:
            out[names[m.group(1).strip().lower()]] = m.group(2).strip().strip("*").strip()
    return out
