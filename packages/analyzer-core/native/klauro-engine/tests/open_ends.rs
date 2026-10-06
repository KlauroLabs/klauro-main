mod common;

fn flow<'a>(index: &'a serde_json::Value, operation: &str) -> &'a serde_json::Value {
    index["comprehension"]["flows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|flow| flow["operation"] == operation)
        .unwrap_or_else(|| panic!("no flow named {operation}"))
}

#[test]
fn a_trail_that_ends_in_our_own_unresolved_code_is_open() {
    let index = common::read("open-ends");
    let found = flow(&index, "ends_in_our_code");
    assert_eq!(found["standing"], "open", "{found}");
    assert!(found["open"].as_u64().unwrap() >= 1, "{found}");
}

#[test]
fn a_call_through_a_trait_object_that_has_implementers_is_not_open() {
    let index = common::read("open-ends");
    let found = flow(&index, "reaches_every_implementer");
    assert_eq!(found["standing"], "reading", "{found}");
    assert!(found.get("open").is_none(), "{found}");
}

#[test]
fn a_trail_that_ends_in_a_known_library_call_is_still_reading() {
    let index = common::read("open-ends");
    let found = flow(&index, "ends_in_a_library");
    assert_eq!(found["standing"], "reading", "{found}");
    assert!(found.get("open").is_none(), "{found}");
}

#[test]
fn an_unresolved_call_naming_nothing_declared_here_is_a_boundary_not_an_open_end() {
    let index = common::read("open-ends");
    let found = flow(&index, "calls_a_name_nothing_here_declares");
    assert_eq!(found["standing"], "reading", "{found}");
}

#[test]
fn an_open_end_beside_a_found_effect_does_not_demote_it() {
    let index = common::read("open-ends");
    let found = flow(&index, "changes_and_ends_in_our_code");
    assert_eq!(found["standing"], "terminal", "{found}");
    assert!(found["open"].as_u64().unwrap() >= 1, "{found}");
}

#[test]
fn a_trail_cut_by_the_depth_it_is_followed_is_open() {
    let index = common::read("open-ends");
    let found = flow(&index, "runs_past_the_depth_it_is_followed");
    assert_eq!(found["standing"], "open", "{found}");
    assert_eq!(found["cut"], true, "{found}");
}

#[test]
fn an_edge_found_by_name_alone_says_so_and_one_found_by_structure_does_not() {
    let index = common::read("guessed-callee-terminal");
    let edges = index["edges"].as_array().unwrap();
    let calls: Vec<&serde_json::Value> = edges.iter().filter(|edge| edge["kind"] == "calls").collect();
    assert!(calls.iter().any(|edge| edge["via"] == "name"), "{calls:?}");
    assert!(calls.iter().any(|edge| edge.get("via").is_none()), "{calls:?}");
}
