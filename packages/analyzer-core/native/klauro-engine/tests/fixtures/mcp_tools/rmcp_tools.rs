use rmcp::tool;

struct ToolBox;

#[tool_router]
impl ToolBox {
    #[tool]
    async fn add(&self, a: i64, b: i64) -> i64 {
        a + b
    }

    #[tool(name = "explicit_tool_name_rs")]
    async fn compute_something(&self, x: i64) -> i64 {
        x * 2
    }
}
