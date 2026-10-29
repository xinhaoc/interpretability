"""Model backends. Each backend takes a unified request and yields text chunks.

Unified message format:
    system: str
    messages: [{"role": "user"|"assistant", "content": [block, ...]}]
    block: {"type": "text", "text": str} | {"type": "image", "media_type": str, "data": base64 str}
"""
import asyncio
import base64
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

import httpx


class BackendError(Exception):
    pass


def _find_exe(name, extra=()):
    path = shutil.which(name)
    if path:
        return path
    home = Path.home()
    for cand in [home / ".local/bin" / name, Path("/opt/homebrew/bin") / name,
                 Path("/usr/local/bin") / name, home / ".npm-global/bin" / name, *extra]:
        if Path(cand).exists():
            return str(cand)
    return None


def _flatten(messages):
    """Collapse a multi-turn history into one user turn (for CLI backends without
    native multi-turn input). Images from every turn are kept, in order."""
    if len(messages) == 1:
        return messages[0]["content"]
    images, parts = [], []
    for i, m in enumerate(messages):
        texts = [b["text"] for b in m["content"] if b["type"] == "text"]
        images += [b for b in m["content"] if b["type"] == "image"]
        who = "Reader" if m["role"] == "user" else "You (assistant)"
        if i == len(messages) - 1:
            parts.append("=== Reader's new message (answer this) ===\n" + "\n".join(texts))
        else:
            parts.append(f"--- {who} ---\n" + "\n".join(texts))
    head = "Earlier conversation in this thread:\n\n"
    return images + [{"type": "text", "text": head + "\n\n".join(parts)}]


async def _iter_lines(stream):
    """Read lines of any length (asyncio's readline caps at 64 KiB)."""
    buf = b""
    while True:
        chunk = await stream.read(65536)
        if not chunk:
            break
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            yield line
    if buf:
        yield buf


# --------------------------------------------------------------------------- Claude Code CLI

async def claude_cli(system, messages, cfg, tools=None):
    exe = cfg.get("path") or _find_exe("claude")
    if not exe:
        raise BackendError("找不到 claude 命令。请先安装 Claude Code，或在设置里填写它的路径。")
    content = []
    for b in _flatten(messages):
        if b["type"] == "image":
            content.append({"type": "image", "source": {"type": "base64", "media_type": b["media_type"], "data": b["data"]}})
        else:
            content.append({"type": "text", "text": b["text"]})
    workdir = tempfile.mkdtemp(prefix="interpretability-")
    sp_file = Path(workdir) / "system.txt"
    sp_file.write_text(system)
    # No built-in tools; the paper tools come from our MCP server when enabled.
    args = [exe, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--include-partial-messages", "--tools", "", "--no-session-persistence",
            "--strict-mcp-config", "--system-prompt-file", str(sp_file)]
    if tools:
        server = Path(__file__).parent / "mcp_server.py"
        mcp_file = Path(workdir) / "mcp.json"
        mcp_file.write_text(json.dumps({"mcpServers": {"paper": {
            "command": sys.executable, "args": [str(server), str(tools)]}}}))
        args += ["--mcp-config", str(mcp_file),
                 "--allowedTools", "mcp__paper__search_paper mcp__paper__read_pages mcp__paper__view_page"]
    if cfg.get("model"):
        args += ["--model", cfg["model"]]
    proc = await asyncio.create_subprocess_exec(
        *args, cwd=workdir, stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    msg = {"type": "user", "message": {"role": "user", "content": content}}
    proc.stdin.write((json.dumps(msg) + "\n").encode())
    await proc.stdin.drain()
    proc.stdin.close()
    got_text = False
    after_tool = False
    try:
        async for raw in _iter_lines(proc.stdout):
            try:
                ev = json.loads(raw)
            except ValueError:
                continue
            t = ev.get("type")
            if t == "stream_event":
                e = ev.get("event", {})
                if e.get("type") == "content_block_delta" and e.get("delta", {}).get("type") == "text_delta":
                    if after_tool and got_text:
                        yield "\n\n"
                    after_tool = False
                    got_text = True
                    yield e["delta"]["text"]
            elif t == "assistant":
                m = ev.get("message", {})
                if m.get("model") == "<synthetic>":
                    txt = "".join(c.get("text", "") for c in m.get("content", []))
                    hint = "\n在终端运行 `claude` 并登录（/login）后再试。" if "auth" in txt.lower() or "login" in txt.lower() else ""
                    raise BackendError(f"Claude Code 报错：{txt}{hint}")
                for c in m.get("content", []):
                    if c.get("type") == "tool_use":
                        after_tool = True
                        yield {"tool": c["name"].removeprefix("mcp__paper__"), "input": c.get("input", {})}
            elif t == "result" and ev.get("is_error") and not got_text:
                raise BackendError(f"Claude Code 报错：{ev.get('result') or ev.get('subtype')}")
        await proc.wait()
        if proc.returncode and not got_text:
            err = (await proc.stderr.read()).decode(errors="replace")[-1500:]
            raise BackendError(f"claude 退出码 {proc.returncode}：{err}")
    finally:
        if proc.returncode is None:
            proc.kill()
        shutil.rmtree(workdir, ignore_errors=True)


# --------------------------------------------------------------------------- Anthropic API

def _run_tool(paper_dir, name, args):
    """Tool result content blocks for the Messages API."""
    import paper_tools
    try:
        if name == "search_paper":
            return [{"type": "text", "text": paper_tools.search_paper(paper_dir, args.get("query", ""))}], False
        if name == "read_pages":
            return [{"type": "text", "text": paper_tools.read_pages(paper_dir, args.get("start", 1), args.get("end"))}], False
        if name == "view_page":
            png = paper_tools.view_page(paper_dir, int(args["page"]), args.get("x0", 0), args.get("y0", 0),
                                        args.get("x1", 1), args.get("y1", 1))
            return [{"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                 "data": base64.b64encode(png).decode()}}], False
        return [{"type": "text", "text": f"unknown tool {name}"}], True
    except Exception as e:
        return [{"type": "text", "text": f"error: {e}"}], True


async def anthropic_api(system, messages, cfg, tools=None):
    import anthropic
    import paper_tools
    kwargs = {}
    if cfg.get("api_key"):
        kwargs["api_key"] = cfg["api_key"]
    if cfg.get("base_url"):
        kwargs["base_url"] = cfg["base_url"]
    client = anthropic.AsyncAnthropic(**kwargs)
    model = cfg.get("model") or "claude-opus-5-5"
    api_msgs = []
    for m in messages:
        blocks = []
        for b in m["content"]:
            if b["type"] == "image":
                blocks.append({"type": "image", "source": {"type": "base64", "media_type": b["media_type"], "data": b["data"]}})
            else:
                blocks.append({"type": "text", "text": b["text"]})
        api_msgs.append({"role": m["role"], "content": blocks})
    params = dict(
        model=model, max_tokens=32000,
        # Memory (or the full paper) lives in the system prompt, so it is cached across questions.
        system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral", "ttl": "1h"}}],
        output_config={"effort": cfg.get("effort") or "medium"},
    )
    if tools:
        params["tools"] = paper_tools.TOOL_SPECS
    use_fallback = model in ("claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5")
    try:
        wrote_text = False
        for _ in range(12):  # tool-use rounds
            if use_fallback:
                # Server-side refusal fallback: a declined request is retried on another model.
                stream_cm = client.beta.messages.stream(
                    betas=["server-side-fallback-2026-07-01"], extra_body={"fallbacks": "default"},
                    messages=api_msgs, **params)
            else:
                stream_cm = client.messages.stream(messages=api_msgs, **params)
            async with stream_cm as stream:
                first = True
                async for text in stream.text_stream:
                    if first and wrote_text:
                        yield "\n\n"
                    first = False
                    wrote_text = True
                    yield text
                final = await stream.get_final_message()
            if final.stop_reason == "refusal":
                yield "\n\n（模型拒绝回答这个请求。）"
                return
            if final.stop_reason != "tool_use":
                return
            # Send the whole assistant turn back unchanged (thinking blocks included).
            api_msgs.append({"role": "assistant", "content": [b.model_dump(exclude_none=True) for b in final.content]})
            results = []
            for b in final.content:
                if b.type == "tool_use":
                    yield {"tool": b.name, "input": b.input}
                    content, is_error = _run_tool(tools, b.name, b.input)
                    results.append({"type": "tool_result", "tool_use_id": b.id, "content": content, "is_error": is_error})
            api_msgs.append({"role": "user", "content": results})
        yield "\n\n（工具调用轮数过多，已停止。）"
    except anthropic.AuthenticationError:
        raise BackendError("Anthropic API key 无效。请在设置里填写，或设置 ANTHROPIC_API_KEY。")
    except anthropic.RateLimitError:
        raise BackendError("Anthropic API 限流了，稍后再试。")
    except anthropic.APIStatusError as e:
        raise BackendError(f"Anthropic API 错误 {e.status_code}：{e.message}")
    except anthropic.APIConnectionError:
        raise BackendError("连不上 Anthropic API，检查网络。")


# --------------------------------------------------------------------------- OpenAI-compatible (Ollama, LM Studio, vLLM, ...)

async def openai_compat(system, messages, cfg, tools=None):
    base = (cfg.get("base_url") or "http://localhost:11434/v1").rstrip("/")
    model = cfg.get("model")
    if not model:
        raise BackendError("请在设置里填写本地模型名（例如 qwen2.5vl:7b）。")
    vision = cfg.get("vision", True)
    out = [{"role": "system", "content": system}]
    for m in messages:
        parts = []
        for b in m["content"]:
            if b["type"] == "image":
                if vision:
                    parts.append({"type": "image_url", "image_url": {"url": f"data:{b['media_type']};base64,{b['data']}"}})
            else:
                parts.append({"type": "text", "text": b["text"]})
        if all(p["type"] == "text" for p in parts):
            out.append({"role": m["role"], "content": "\n".join(p["text"] for p in parts)})
        else:
            out.append({"role": m["role"], "content": parts})
    headers = {"Authorization": f"Bearer {cfg['api_key']}"} if cfg.get("api_key") else {}
    body = {"model": model, "messages": out, "stream": True}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(600, connect=10)) as client:
            async with client.stream("POST", f"{base}/chat/completions", json=body, headers=headers) as r:
                if r.status_code >= 400:
                    raise BackendError(f"{base} 返回 {r.status_code}：{(await r.aread()).decode(errors='replace')[:800]}")
                async for line in r.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        delta = json.loads(data)["choices"][0].get("delta", {})
                    except (ValueError, KeyError, IndexError):
                        continue
                    if delta.get("content"):
                        yield delta["content"]
    except httpx.ConnectError:
        raise BackendError(f"连不上 {base}。本地模型服务（如 `ollama serve`）启动了吗？")


# --------------------------------------------------------------------------- Codex CLI

async def codex_cli(system, messages, cfg, tools=None):
    """Codex prints its answer only when done, so while it works this yields {"status": ...}
    every few seconds (elapsed time, and its reasoning summaries as they finish)."""
    exe = cfg.get("path") or _find_exe("codex")
    if not exe:
        raise BackendError("找不到 codex 命令。请先安装（npm i -g @openai/codex）并登录，或在设置里填写路径。")
    workdir = tempfile.mkdtemp(prefix="interpretability-")
    try:
        blocks = _flatten(messages)
        args = [exe, "exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never",
                "-c", f"model_reasoning_effort={cfg.get('effort') or 'medium'}"]
        if cfg.get("model"):
            args += ["-m", cfg["model"]]
        for i, b in enumerate(x for x in blocks if x["type"] == "image"):
            p = Path(workdir) / f"img{i}.png"
            p.write_bytes(base64.b64decode(b["data"]))
            args += ["-i", str(p)]
        out_file = Path(workdir) / "last.txt"
        args += ["--output-last-message", str(out_file), "-"]
        prompt = (f"<instructions>\n{system}\n</instructions>\n\n"
                  "Do not run commands or edit files; just answer.\n\n"
                  + "\n".join(b["text"] for b in blocks if b["type"] == "text"))
        proc = await asyncio.create_subprocess_exec(
            *args, cwd=workdir, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=1 << 24)
        err_task = asyncio.create_task(proc.stderr.read())
        t0, thought, failure = time.monotonic(), "", ""

        def status():
            m, s = divmod(int(time.monotonic() - t0), 60)
            took = f"{m} 分 {s} 秒" if m else f"{s} 秒"
            return {"status": f"Codex 在想：{thought}（已用 {took}）" if thought else
                    f"Codex 正在读、在想…（已用 {took}；Codex 想完才一次性给出回答）"}
        try:
            proc.stdin.write(prompt.encode())
            await proc.stdin.drain()
            proc.stdin.close()
            yield status()
            while True:
                try:
                    line = await asyncio.wait_for(proc.stdout.readline(), 10)
                except asyncio.TimeoutError:
                    yield status()
                    continue
                if not line:
                    break
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                item = ev.get("item") or {}
                if ev.get("type") == "item.completed" and item.get("type") == "reasoning" and item.get("text"):
                    thought = item["text"].strip().splitlines()[0].strip("*# ")[:80]
                    yield status()
                elif ev.get("type") in ("error", "turn.failed"):
                    failure = (ev.get("error") or {}).get("message") or ev.get("message") or failure
            await proc.wait()
            err = await err_task
        except BaseException:  # the reader stopped the answer: don't leave codex running
            proc.kill()
            await proc.wait()
            err_task.cancel()
            raise
        if out_file.exists() and out_file.read_text().strip():
            yield out_file.read_text()
        else:
            raise BackendError(f"codex 退出码 {proc.returncode}：{failure or err.decode(errors='replace')[-1500:]}")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


# --------------------------------------------------------------------------- Mock (UI testing, no model)

async def mock(system, messages, cfg, tools=None):
    if tools:
        await asyncio.sleep(0.2)
        yield {"tool": "search_paper", "input": {"query": "attention"}}
        yield {"tool": "view_page", "input": {"page": 3}}
    last = messages[-1]["content"]
    n_img = sum(1 for b in last if b["type"] == "image")
    text = next((b["text"] for b in reversed(last) if b["type"] == "text"), "")
    reply = (f"**测试后端**（没有调用模型）。\n\n收到 {n_img} 张图片，"
             f"系统提示 {len(system)} 字符，本轮输入 {len(text)} 字符。\n\n"
             "行内公式 $E = mc^2$，独立公式：\n\n$$\\mathrm{Attn}(Q,K,V)=\\mathrm{softmax}\\left(\\frac{QK^\\top}{\\sqrt{d_k}}\\right)V$$\n\n"
             "- 列表项一\n- 列表项二\n\n```python\nprint('code block')\n```\n\n输入的最后 300 字：\n\n> "
             + text[-300:].replace("\n", " "))
    for i in range(0, len(reply), 12):
        await asyncio.sleep(0.03)
        yield reply[i:i + 12]


# Backends that can call search_paper / view_page themselves.
TOOL_BACKENDS = {"claude_cli", "anthropic"}
# Backends that can look at images (the figure pass needs this).
def can_see(name, cfg):
    return name in ("claude_cli", "anthropic", "codex", "mock") or (name == "openai" and cfg.get("vision", True))


BACKENDS = {
    "claude_cli": claude_cli,
    "anthropic": anthropic_api,
    "openai": openai_compat,
    "codex": codex_cli,
    "mock": mock,
}


def detect():
    return {
        "claude_cli": bool(_find_exe("claude")),
        "codex": bool(_find_exe("codex")),
        "anthropic_key": bool(os.environ.get("ANTHROPIC_API_KEY")),
    }
