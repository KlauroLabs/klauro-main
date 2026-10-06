mod common;

use serde_json::Value;

fn routes(index: &Value) -> Vec<(String, String, Vec<String>)> {
    let mut found: Vec<(String, String, Vec<String>)> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "http")
        .map(|entry| {
            (
                entry["method"].as_str().unwrap_or_default().to_string(),
                entry["path"].as_str().unwrap().to_string(),
                entry["guards"]
                    .as_array()
                    .map(|held| held.iter().map(|guard| guard["name"].as_str().unwrap().to_string()).collect())
                    .unwrap_or_default(),
            )
        })
        .collect();
    found.sort();
    found.dedup();
    found
}

#[test]
fn middleware_named_in_a_route_call_guards_that_route_and_is_never_its_handler() {
    let index = common::read("route-middleware");
    let found = routes(&index);
    let guarded = |method: &str, path: &str| {
        found.iter().filter(|(held, at, _)| held == method && at == path).flat_map(|(_, _, guards)| guards.clone()).collect::<Vec<_>>()
    };
    assert_eq!(guarded("GET", "/users"), Vec::<String>::new());
    assert_eq!(guarded("DELETE", "/users/:id"), vec!["requireAuth"]);
    assert!(guarded("POST", "/users").contains(&"requireAuth".to_string()));
    assert!(guarded("POST", "/users").contains(&"AuthRequired".to_string()));
    let handlers: Vec<&str> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "http")
        .map(|entry| entry["handler"].as_str().unwrap())
        .collect();
    assert!(!handlers.iter().any(|held| held.contains("requireAuth") || held.contains("AuthRequired")), "{handlers:?}");
}
