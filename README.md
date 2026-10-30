# interpretability

**Read every line. Understand every step.** A local app for reading papers with AI: select any line, equation or figure and have it explained.

![interpretability](docs/preview.gif)

▶ [Watch the full promo (50 s)](https://github.com/xinhaoc/interpretability/releases/download/v0.1.0/interpretability-promo.mp4)

## Features

- **Select and ask**: select text, or draw a box around an equation or figure, then pick Explain / Derive / Simplify / Connect / Critique, or type your own question and keep following up.
- **Read once, remember**: after import, the model reads the whole paper once and writes notes, a notation table and a description of every figure. Every later question uses this memory, so switching models never means re-reading.
- **Checked quotes**: quotes in answers are matched against the PDF and marked ✓ when found or ⚠ when not. Figure, Eq., §, [17] and page references show a preview on hover and jump there on click.
- **Derivation maps**: generate an editable mind map of the paper's argument, from the problem and key idea through each equation to the evidence. Every node shows where it comes from.
- **Your notes**: highlights, margin notes and free-form notes go into the memory too, so answers build on them.

## Install

**Download** [interpretability-0.2.1-arm64.dmg](https://github.com/xinhaoc/interpretability/releases/download/v0.2.1/interpretability-0.2.1-arm64.dmg) (Apple Silicon Mac, macOS 13+). Nothing else to install.

1. Open the DMG and drag **interpretability** into Applications.
2. The app is not notarized by Apple, so macOS blocks the first launch. Open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**. Or run once in Terminal:
   ```bash
   xattr -dr com.apple.quarantine /Applications/interpretability.app
   ```
3. Choose a model with ⚙ (see below).

**From source** (needs Xcode Command Line Tools and Python 3.10+):

```bash
git clone https://github.com/xinhaoc/interpretability.git
cd interpretability
pip install -r requirements.txt
./macos/build.sh      # builds and installs interpretability.app using your Python
./macos/package.sh    # or: a self-contained app and DMG, like the download
```

To run without the app, use `python3 app.py` and open http://127.0.0.1:8765.

## Models

Switch with ⚙ in the top-right corner:

- **Claude Code** (default): uses your Claude subscription. Run `claude` once in a terminal to log in.
- **Anthropic API**: needs an API key.
- **Codex CLI**: uses your ChatGPT subscription.
- **Local models**: Ollama, LM Studio or any OpenAI-compatible endpoint.

Papers, notes and memory stay on your machine in `~/Interpretability/`.

## License

[AGPL-3.0](LICENSE). Bundles pdf.js, KaTeX, marked, DOMPurify and Mind Elixir; PDF text extraction uses PyMuPDF.
