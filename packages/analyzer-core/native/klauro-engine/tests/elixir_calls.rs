mod common;

use common::calls;

#[test]
fn a_local_call_reaches_the_function_in_its_own_module_even_when_the_head_carries_a_guard() {
    let index = common::read("elixir_calls");
    assert!(calls(&index, "accounts.ex:function:save", "accounts.ex:function:normalize"));
}

#[test]
fn a_call_through_an_alias_reaches_the_module_it_names() {
    let index = common::read("elixir_calls");
    assert!(calls(&index, "web.ex:function:create", "accounts.ex:function:save"));
    assert!(calls(&index, "accounts.ex:function:save", "repo.ex:function:insert"));
}

#[test]
fn a_definition_head_and_a_directive_are_not_calls() {
    let index = common::read("elixir_calls");
    let edges = index["edges"].as_array().unwrap();
    assert!(!edges.iter().any(|edge| {
        edge["kind"] == "calls" && edge["source"] == edge["target"]
    }));
    assert!(!index["calls"].as_array().unwrap().iter().any(|call| {
        matches!(call["callee"].as_str(), Some("def" | "defp" | "defmodule" | "alias" | "import" | "use" | "moduledoc"))
    }));
}
