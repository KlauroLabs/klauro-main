from mcp.server.fastmcp import FastMCP

mcp = FastMCP("demo")


@mcp.tool()
def add(a: int, b: int) -> int:
    return a + b


@mcp.tool(name="explicit_tool_name_py")
def compute_something(x: int) -> int:
    return x * 2
