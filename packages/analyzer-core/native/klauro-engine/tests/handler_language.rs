mod common;

fn handler_of(index: &serde_json::Value, path: &str) -> Option<String> {
    index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["kind"] == "http" && entry["path"] == path)
        .map(|entry| entry["handler"].as_str().unwrap().to_string())
}

#[test]
fn a_handler_is_never_resolved_to_a_function_of_another_language_that_shares_its_name() {
    let index = common::read("handler-language");
    let handler = handler_of(&index, "/ping").expect("the route is served");
    assert!(!handler.contains(".py"), "a JavaScript route must not start in a Python function, got {handler}");
}

#[test]
fn a_handler_declared_in_the_same_language_still_resolves() {
    let index = common::read("handler-language");
    let handler = handler_of(&index, "/shared").expect("the route is served");
    assert!(common::names(&handler, "sharedHandler"), "got {handler}");
}
