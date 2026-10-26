"""MCP server exposing the paper tools to Claude Code.

Usage: python mcp_server.py <paper_dir>
"""
import sys
from pathlib import Path

from mcp.server.fastmcp import FastMCP, Image

import paper_tools

PAPER = Path(sys.argv[1])
mcp = FastMCP("paper")
SPECS = {t["name"]: t for t in paper_tools.TOOL_SPECS}


@mcp.tool(description=SPECS["search_paper"]["description"])
def search_paper(query: str) -> str:
    return paper_tools.search_paper(PAPER, query)


@mcp.tool(description=SPECS["read_pages"]["description"])
def read_pages(start: int, end: int = 0) -> str:
    return paper_tools.read_pages(PAPER, start, end or None)


@mcp.tool(description=SPECS["view_page"]["description"])
def view_page(page: int, x0: float = 0.0, y0: float = 0.0, x1: float = 1.0, y1: float = 1.0) -> Image:
    return Image(data=paper_tools.view_page(PAPER, page, x0, y0, x1, y1), format="png")


if __name__ == "__main__":
    mcp.run()
