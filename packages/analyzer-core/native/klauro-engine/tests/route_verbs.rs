mod common;

use serde_json::Value;

fn served(fixture: &str) -> Vec<(String, String)> {
    let index: Value = common::read(fixture);
    let mut found: Vec<(String, String)> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "http")
        .map(|entry| {
            (
                entry["method"].as_str().unwrap_or_default().to_string(),
                entry["path"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    found.sort();
    found
}

fn pair(method: &str, path: &str) -> (String, String) {
    (method.to_string(), path.to_string())
}

#[test]
fn a_rust_attribute_macro_named_for_a_verb_is_a_route() {
    assert_eq!(
        served("route-verbs/rs"),
        vec![pair("DELETE", "/users/{id}"), pair("GET", "/users"), pair("POST", "/users")]
    );
}

#[test]
fn a_methods_call_chained_after_a_registration_names_its_verb() {
    assert_eq!(served("route-verbs/go"), vec![pair("GET", "/users"), pair("POST", "/users")]);
}

#[test]
fn a_django_view_serves_the_methods_it_declares() {
    assert_eq!(
        served("route-verbs/py"),
        vec![
            pair("DELETE", "/users/{id}"),
            pair("GET", "/items"),
            pair("GET", "/users"),
            pair("POST", "/items"),
            pair("POST", "/users"),
        ]
    );
}

#[test]
fn a_mount_prefixes_the_attribute_routes_it_lists() {
    assert_eq!(
        served("route-verbs/rocket"),
        vec![pair("GET", "/api/users"), pair("GET", "/ping"), pair("POST", "/api/users")]
    );
}
