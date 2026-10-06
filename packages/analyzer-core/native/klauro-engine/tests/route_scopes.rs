mod common;

fn guarded(fixture: &str) -> Vec<(String, String, usize)> {
    let index = common::read(fixture);
    let mut found: Vec<(String, String, usize)> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "http")
        .map(|entry| {
            (
                entry["method"].as_str().unwrap_or_default().to_string(),
                entry["path"].as_str().unwrap().to_string(),
                entry["guards"].as_array().map_or(0, Vec::len),
            )
        })
        .collect();
    found.sort();
    found.dedup();
    found
}

fn route(method: &str, path: &str, guards: usize) -> (String, String, usize) {
    (method.to_string(), path.to_string(), guards)
}

#[test]
fn a_group_that_uses_a_guard_guards_the_routes_registered_on_it() {
    assert_eq!(guarded("route-scopes/gin"), vec![route("GET", "/admin/users", 1), route("GET", "/users", 0)]);
}

#[test]
fn a_scope_that_wraps_routes_in_a_guard_call_guards_each() {
    assert_eq!(guarded("route-scopes/ktor"), vec![route("GET", "/users", 0), route("POST", "/users", 1)]);
}

#[test]
fn a_filter_limited_to_actions_guards_only_those() {
    assert_eq!(guarded("route-scopes/rails"), vec![route("GET", "/users", 0), route("POST", "/users", 1)]);
}

#[test]
fn a_layer_chained_after_a_route_guards_it() {
    assert_eq!(guarded("route-scopes/axum"), vec![route("GET", "/users", 0), route("POST", "/users", 1)]);
}

#[test]
fn middleware_chained_after_a_route_guards_it_even_when_no_controller_is_declared() {
    assert_eq!(guarded("route-scopes/laravel"), vec![route("GET", "/users", 0), route("POST", "/users", 1)]);
}

#[test]
fn a_router_that_uses_a_guard_guards_only_the_routes_registered_after_it() {
    let found = guarded("route-scopes/express");
    assert!(found.contains(&route("GET", "/health", 0)), "{found:?}");
    assert!(found.contains(&route("GET", "/users", 1)), "{found:?}");
    assert!(found.contains(&route("POST", "/users", 1)), "{found:?}");
}
