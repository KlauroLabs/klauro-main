mod common;

fn index() -> serde_json::Value {
    common::read("dev_tooling_boundary")
}

fn entries(index: &serde_json::Value) -> Vec<&serde_json::Value> {
    index["entry_points"].as_array().unwrap().iter().collect()
}

fn handled_at<'a>(entries: &[&'a serde_json::Value], suffix: &str) -> Option<&'a serde_json::Value> {
    entries.iter().copied().find(|entry| {
        entry["handler"].as_str().is_some_and(|handler| handler.contains(suffix))
    })
}

#[test]
fn a_developer_script_that_nothing_ships_is_not_an_entry() {
    let index = index();
    let entries = entries(&index);
    assert!(
        handled_at(&entries, "scripts/unshipped.js").is_none(),
        "a script no manifest runs or ships must not become a flow: {entries:#?}"
    );
}

#[test]
fn a_developer_script_a_manifest_ships_stays_an_entry() {
    let index = index();
    let entries = entries(&index);
    let found = handled_at(&entries, "scripts/shipped.js")
        .expect("package.json's bin names this script, so it still ships");
    assert_eq!(found["kind"], "lifecycle");
}

#[test]
fn a_main_under_examples_is_not_an_entry() {
    let index = index();
    let entries = entries(&index);
    assert!(
        handled_at(&entries, "examples/demo.py").is_none(),
        "example code is not product code: {entries:#?}"
    );
}

#[test]
fn an_http_handler_under_tests_is_not_an_entry() {
    let index = index();
    let entries = entries(&index);
    assert!(
        handled_at(&entries, "tests/routes.py").is_none(),
        "test code is not product code: {entries:#?}"
    );
}

#[test]
fn a_real_source_route_still_serves() {
    let index = index();
    let entries = entries(&index);
    let found = handled_at(&entries, "src/routes.py").expect("a real route in src/ is still an entry point");
    assert_eq!(found["kind"], "http");
    assert_eq!(found["path"], "/real");
}
