mod common;

#[test]
fn a_dot_integration_dot_file_is_treated_as_test_code() {
    let index = common::read("integration_test_marker");
    let entries: Vec<&serde_json::Value> = index["entry_points"].as_array().unwrap().iter().collect();
    let found = entries.iter().find(|entry| {
        entry["handler"].as_str().is_some_and(|handler| handler.contains("pg-vector-store.integration.ts"))
    });
    assert!(
        found.is_none_or(|entry| entry["kind"] == "test"),
        "a `.integration.` file is unambiguous test code, like `.test.`/`.spec.`: {entries:#?}"
    );
}
