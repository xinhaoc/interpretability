# interpretability

**读懂每一篇论文。** 一个在本地运行的读论文工具：选中任意一行、公式或图表，让 AI 讲给你听。

![interpretability](docs/preview.gif)

▶ [观看完整宣传片（50 秒）](https://github.com/xinhaoc/interpretability/releases/download/v0.1.0/interpretability-promo.mp4)

## 能做什么

- **选中就问**：选中文字或框选公式、图表，一键「解释 / 推导 / 通俗讲 / 联系全文 / 挑毛病」，也可以自己提问、接着追问。
- **读一遍就记住**：导入后模型通读全文，记下笔记、符号表和每张图表。之后的提问都用这份记忆，换模型也不用重读。
- **引用可核对**：回答里引用的原文会去 PDF 里逐句核对，找到的打 ✓，找不到的打 ⚠。Figure、Eq.、§、[17] 都能悬停预览、点击跳转。
- **推导图**：一键生成可编辑的思维导图，从问题、想法、公式推导一直到实验证据，每个节点都标出原文出处。
- **你的笔记**：划线、批注、自由笔记也会存进记忆，模型回答时能看到。

## 安装

需要 macOS 和 Python 3.10+。

```bash
git clone https://github.com/xinhaoc/interpretability.git
cd interpretability
pip install -r requirements.txt
./macos/build.sh    # 打包并安装 interpretability.app
```

不想装 App 的话，运行 `python3 app.py`，然后在浏览器里打开 http://127.0.0.1:8765。

## 接入模型

在右上角 ⚙ 里切换：

- **Claude Code**（默认）：用你的 Claude 订阅，先在终端运行一次 `claude` 登录。
- **Anthropic API**：填 API key。
- **Codex CLI**：用你的 ChatGPT 订阅。
- **本地模型**：Ollama、LM Studio 等任何 OpenAI 兼容接口。

论文、笔记和记忆都存在本地的 `~/Interpretability/`。

## License

[AGPL-3.0](LICENSE)。内置了 pdf.js、KaTeX、marked、DOMPurify、Mind Elixir，PDF 文字提取用的是 PyMuPDF。
