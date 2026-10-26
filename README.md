# interpretability

读懂每一篇论文.

A local web app for reading papers with an AI. You import a paper, the model reads all of it once and writes notes, and then you ask about any line, equation or figure as you read.

## Start

**Mac app**: open **interpretability** from Applications or Launchpad. It starts the server, shows the app in its own window, and stops the server when you quit. Open PDFs with it from Finder (Open With), drop them on its Dock icon, or use ⌘O. The app carries its own copy of the code, so after changing the code run `./macos/build.sh` (about 10 seconds) and reopen the app. ⌘W closes the window and keeps the app running; click the Dock icon to bring it back. Quitting, or the app crashing, also stops the server.

Without the app: double-click `interpretability.command`, or run:

```bash
cd ~/Desktop/interpretability && python3 app.py
```

The browser opens at http://127.0.0.1:8765. Data is stored in `~/Interpretability/` (set `INTERPRETABILITY_DATA` to change this). Data from the old `~/PaperReader/` folder is moved there on first start.

## Use

- **Import**: click 导入 PDF, drag a PDF into the window, or paste an arXiv ID or link (`1706.03762`, `arxiv.org/abs/...`, an OpenReview link, or any PDF URL).
- **First read**: after you import a paper, the model reads it and writes notes (TL;DR, method, a notation table, key equations, figures, experiments, limitations). It then looks at every figure and table once. Both go into the paper's memory (the 记忆 tab), described below.
- **Ask about text**: select text and pick 解释 / 推导 / 通俗讲 / 联系全文 / 挑毛病, or type your own question. By default a screenshot of the selected area is sent too, because PDF text extraction breaks math.
- **Ask about an equation, figure or table**: press `R` (or hold Option) and drag a box around it. The model gets a high-resolution image of the box, the text inside it, and the text around it.
- **Follow up**: each question is a thread that you can keep asking in. When a thread is open and you select something new, the popup asks whether to start a new thread or add the selection to the open one (接着 #n 问).
- **Find old questions**: questions you asked are lightly highlighted on the page, with a numbered pin in the margin. Click the pin, or click (without dragging) on highlighted text, to open the thread. Highlights never block selecting or box-selecting.
- **Jump around**: in answers and notes, Figure N, Table N, Eq. (N), §N.N, [N] and [p.N] are links. Hover to see a preview of that spot; click to jump there (it flashes). The PDF's own links (citations, figure references) show the same preview. ↩ (or Alt+← / Backspace) takes you back to where you were reading.
- **Your own notes** (笔记 tab): select text or box a region and click ✎ 记笔记 to highlight it in a color and write a margin note; it shows as a ✎ pin on the left margin. The 笔记 tab also has free-form notes (Markdown, autosaved), and 摘到笔记 under any answer copies it there.
- **Fix the AI's notes**: ✎ 编辑 in the 记忆 tab. An edited version is never overwritten: a later re-read is kept aside, and you choose to look at it, switch to it (your version is backed up), or drop it.
- **推导图 (derivation map)**: 🧭 in the top bar opens a full-window, editable mind map of how the paper argues: problem → key idea → method (each equation as its own step) → evidence → limitations. Every node shows where it comes from (Figure / Eq. / § / page) and, when it quotes the paper, whether the quote was found in the PDF; figure and table nodes show the figure itself. Select a node to see its dependency links (dashed), ↗ jump to the source, ＋ let the AI expand it, or 💬 ask about it. Edit freely (double-click, Tab, drag); an edited map is part of the paper's memory. Export to PNG, Markdown or OPML (XMind / 幕布) goes to Downloads.
- **Stop** an answer with ■ 停止. Click the page number in the top bar to jump to a page; pinch or Ctrl+scroll to zoom.
- **Whole-paper questions**: use the box at the top of the 问答 tab.

## Memory

Each paper has its own memory in `~/Interpretability/papers/<id>/memory/`. The app owns it, so every model uses the same memory and you never pay for a second full read.

- `notes.md`: notes from the first full read.
- `figures.json`: every figure and table, with a description written by a vision model that looked at the page once. Text-only models can use these descriptions too.
- `qa.json`: what came out of each Q&A thread. After every answer, the useful points are summarized into this file.
- `my_notes.md`, `annotations.json`: your own notes and margin notes. They go to the model with every question, so answers build on your understanding (and point out when it is wrong).

The **上下文** switch in the top bar sets what goes with each question:

- **📒 记忆** (default): the memory plus the page you are on. When the model needs a detail, it looks it up itself with two tools: `search_paper` searches the full text, and `view_page` looks at any page or region. Claude Code (through `mcp_server.py`) and the Anthropic API call these tools directly. For other backends, the app searches the text itself and adds what it finds to the question.
- **📄 全文**: the whole paper text plus the memory, with every question. Details are most reliable this way, but each question uses more tokens.

## How answers are grounded

- **Checked quotes**: the model quotes the paper word for word as “…” [p.N]. The app matches each quote against the PDF (fuzzy, word by word, also on the neighbouring page): ✓ means found, and a click highlights the exact words; ⚠ means not found (paraphrased or misremembered). Facts saved to memory carry such a quote, or are tagged 推断.
- **Tools** (memory mode, Claude Code / Anthropic API): `search_paper` (keywords), `read_pages` (whole pages; the memory includes the paper's outline with page numbers), `view_page` (an image of a page or region).
- **LaTeX source**: for arXiv papers the first read (and 全文 mode) also gets the authors' LaTeX, fetched once and saved as `latex.tex`, so equations and symbol macros are exact.

## Models (⚙ in the top-right)

| Backend | What it uses | Setup |
|---|---|---|
| Claude Code (default) | the local `claude` command and your Claude subscription | run `claude` once in a terminal and log in |
| Anthropic API | an API key; the paper is prompt-cached, so follow-up questions are cheap | paste the key, or set `ANTHROPIC_API_KEY` |
| Codex CLI | the local `codex` command and your ChatGPT subscription | `npm i -g @openai/codex`, then `codex login` |
| Local / OpenAI-compatible | Ollama, LM Studio, vLLM, OpenAI… | e.g. `ollama serve`, base URL `http://localhost:11434/v1`, and a vision model such as `qwen2.5vl:7b` |
| 测试 | no model; it echoes what it received | – |

For a local model with a small context, set the character limit. Papers that do not fit are read in parts for the first-pass notes, and 全文 mode then sends only the pages near the selection.

## Files

- `app.py`: server, PDF import, prompts, first-read job, Q&A threads
- `backends.py`: the model backends
- `memory.py`: per-paper memory (notes, figures, Q&A), figure pass and Q&A distillation prompts
- `paper_tools.py`, `mcp_server.py`: the `search_paper` / `view_page` tools
- `anchors.py`: where sections, figures, tables, equations and references are on the page
- `latex.py`: fetches and flattens the arXiv LaTeX source
- `mindmap.py`, `static/mindmap.js`: the derivation map (prompt, parser, grounding, exports; editor is Mind Elixir, MIT)
- `macos/`: the Mac app shell (`main.swift`), its icon and build script
- `static/`: the UI (pdf.js, KaTeX and marked are bundled in `static/vendor`, so the app works offline)

## Third-party code

Bundled in `static/vendor/` so the app works offline: [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0), [KaTeX](https://github.com/KaTeX/KaTeX) (MIT), [marked](https://github.com/markedjs/marked) (MIT), [DOMPurify](https://github.com/cure53/DOMPurify) (Apache-2.0 / MPL-2.0), [Mind Elixir](https://github.com/SSShooter/mind-elixir-core) (MIT). PDF text extraction uses [PyMuPDF](https://github.com/pymupdf/PyMuPDF) (AGPL-3.0), installed from PyPI.

## License

[AGPL-3.0](LICENSE). The PDF text extraction library, PyMuPDF, is AGPL-3.0 as well.
