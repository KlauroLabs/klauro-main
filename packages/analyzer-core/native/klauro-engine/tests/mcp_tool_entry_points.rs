mod common;

fn tool_entries(index: &serde_json::Value) -> Vec<&serde_json::Value> {
    index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "tool")
        .collect()
}

fn find_by_name<'a>(entries: &[&'a serde_json::Value], name: &str) -> Option<&'a serde_json::Value> {
    entries.iter().find(|entry| entry["name"] == name).copied()
}

#[test]
fn a_registered_tool_with_a_named_handler_is_a_tool_entry_point_named_by_its_literal() {
    let index = common::read("mcp_tools");
    let entries = tool_entries(&index);

    let entry = find_by_name(&entries, "find_tests")
        .unwrap_or_else(|| panic!("expected a tool entry named find_tests, found {entries:?}"));
    assert!(
        common::names(entry["handler"].as_str().unwrap(), "handleFindTests"),
        "registerTool should point its handler at the referenced function, got {:?}",
        entry["handler"]
    );
    assert_eq!(entry["registrar"], "server.registerTool");
}

#[test]
fn a_bare_dot_tool_call_is_an_mcp_tool_only_when_the_file_speaks_the_sdk() {
    let index = common::read("mcp_tools");
    let entries = tool_entries(&index);

    let entry = find_by_name(&entries, "say_hello")
        .unwrap_or_else(|| panic!("expected a tool entry named say_hello, found {entries:?}"));
    assert_eq!(entry["registrar"], "server.tool");

    assert!(
        !entries.iter().any(|entry| entry["name"] == "not_an_mcp_tool"),
        "a plain .tool() method on an unrelated class must not be treated as an MCP tool, found {entries:?}"
    );
}

#[test]
fn each_switch_case_on_the_tool_name_is_its_own_tool_entry_point_starting_the_flow_at_the_case() {
    let index = common::read("mcp_tools");
    let entries = tool_entries(&index);

    let greet = find_by_name(&entries, "greet")
        .unwrap_or_else(|| panic!("expected a tool entry named greet, found {entries:?}"));
    assert_eq!(greet["registrar"], "dispatch:tool");
    let handler = greet["handler"].as_str().unwrap();
    assert!(
        common::calls(&index, handler, "handleGreeting"),
        "the 'greet' case's flow should start at the case block and reach handleGreeting"
    );

    assert!(
        find_by_name(&entries, "list_items").is_some(),
        "expected a tool entry named list_items, found {entries:?}"
    );

    assert!(
        !entries.iter().any(|entry| entry["name"] == "unknown tool"),
        "the default case must not become a tool entry, found {entries:?}"
    );
}

#[test]
fn fastmcp_decorated_functions_are_tool_entries_and_an_explicit_name_wins_over_the_function_name() {
    let index = common::read("mcp_tools");
    let entries = tool_entries(&index);

    let add = find_by_name(&entries, "add")
        .unwrap_or_else(|| panic!("expected a tool entry named add, found {entries:?}"));
    assert!(common::names(add["handler"].as_str().unwrap(), "add"));

    let renamed = find_by_name(&entries, "explicit_tool_name_py")
        .unwrap_or_else(|| panic!("expected a tool entry named explicit_tool_name_py, found {entries:?}"));
    assert!(
        common::names(renamed["handler"].as_str().unwrap(), "compute_something"),
        "an explicit name= kwarg should still point the handler at the decorated function, got {:?}",
        renamed["handler"]
    );
}

#[test]
fn rmcp_attributed_methods_are_tool_entries() {
    let index = common::read("mcp_tools");
    let entries = tool_entries(&index);

    assert!(find_by_name(&entries, "add").is_some(), "expected an rmcp #[tool] method named add, found {entries:?}");
    assert!(
        entries.iter().any(|entry| entry["name"] == "explicit_tool_name_rs" && common::names(entry["handler"].as_str().unwrap(), "compute_something")),
        "expected the rmcp #[tool(name = ..)] override to resolve to compute_something, found {entries:?}"
    );
}

#[test]
fn csharp_mcp_server_tool_attributed_methods_are_tool_entries() {
    let index = common::read("mcp_tools");
    let entries = tool_entries(&index);

    assert!(find_by_name(&entries, "Add").is_some(), "expected a C# [McpServerTool] method named Add, found {entries:?}");
    assert!(
        entries.iter().any(|entry| entry["name"] == "explicit_tool_name_cs" && common::names(entry["handler"].as_str().unwrap(), "ComputeSomething")),
        "expected the C# [McpServerTool(Name = ..)] override to resolve to ComputeSomething, found {entries:?}"
    );
}

#[test]
fn go_add_tool_new_tool_pairs_are_tool_entries() {
    let index = common::read("mcp_tools");
    let entries = tool_entries(&index);

    let entry = find_by_name(&entries, "list_go_tools")
        .unwrap_or_else(|| panic!("expected a tool entry named list_go_tools from Go AddTool, found {entries:?}"));
    assert!(common::names(entry["handler"].as_str().unwrap(), "listGoToolsHandler"));
}
