using ModelContextProtocol.Server;

public class ToolBox
{
    [McpServerTool]
    public int Add(int a, int b) => a + b;

    [McpServerTool(Name = "explicit_tool_name_cs")]
    public int ComputeSomething(int x) => x * 2;
}
