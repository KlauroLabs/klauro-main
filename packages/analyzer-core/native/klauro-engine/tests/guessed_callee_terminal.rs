mod common;

fn flow<'a>(index: &'a serde_json::Value, operation: &str) -> &'a serde_json::Value {
    index["comprehension"]["flows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|flow| flow["operation"] == operation)
        .unwrap_or_else(|| panic!("no flow named {operation}"))
}

fn path_units(flow: &serde_json::Value) -> Vec<&str> {
    flow["path"].as_array().unwrap().iter().map(|step| step["unit"].as_str().unwrap()).collect()
}

#[test]
fn a_call_through_an_uncertainly_named_receiver_still_reaches_the_write_it_makes() {
    let index = common::read("guessed-callee-terminal");
    let found = flow(&index, "archive:delete");
    assert_eq!(found["standing"], "terminal", "{found}");
    let units = path_units(found);
    assert!(units.iter().any(|unit| unit.contains("do_write")), "{units:?}");
    let changes = found["changes"].as_array().unwrap();
    assert!(
        changes.iter().any(|held| held.as_str().unwrap().contains("remove_dir_all")),
        "{changes:?}"
    );
}

#[test]
fn a_javascript_await_through_an_uncertainly_named_receiver_still_reaches_the_write_it_makes() {
    let index = common::read("guessed-callee-terminal-js");
    let found = flow(&index, "/api/session");
    assert_eq!(found["standing"], "terminal", "{found}");
    let units = path_units(found);
    assert!(units.iter().any(|unit| unit.contains("save")), "{units:?}");
    let changes = found["changes"].as_array().unwrap();
    assert!(changes.iter().any(|held| held.as_str().unwrap().contains("unlink")), "{changes:?}");
}
