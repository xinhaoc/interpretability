#!/bin/zsh -l
# Double-click to start interpretability. Close this window to stop it.
cd "$(dirname "$0")"
python3 -c "import fitz, fastapi, uvicorn, httpx, anthropic, multipart, mcp" 2>/dev/null || python3 -m pip install -r requirements.txt
exec python3 app.py
