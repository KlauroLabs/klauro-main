mod common;

fn routes(fixture: &str) -> Vec<(String, String, String)> {
    let index = common::read(fixture);
    index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "http")
        .map(|entry| {
            (
                entry["method"].as_str().unwrap_or_default().to_string(),
                entry["path"].as_str().unwrap_or_default().to_string(),
                entry["handler"].as_str().unwrap_or_default().rsplit(':').next().unwrap_or_default().to_string(),
            )
        })
        .collect()
}

fn serves(found: &[(String, String, String)], method: &str, path: &str, action: &str) -> bool {
    found.iter().any(|(m, p, a)| m == method && p == path && a == action)
}

#[test]
fn a_controller_inherits_the_route_of_its_base_class_under_its_own_name() {
    let found = routes("inherited_routes");
    assert!(serves(&found, "GET", "/Tasks/{taskId}", "GetTask"), "{found:?}");
}

#[test]
fn an_action_token_is_the_name_of_the_action() {
    let found = routes("inherited_routes");
    assert!(serves(&found, "POST", "/Tasks/Start", "Start"), "{found:?}");
}

#[test]
fn a_route_listing_several_methods_serves_each_of_them() {
    let found = routes("attribute_methods");
    assert!(serves(&found, "GET", "/profile/edit", "edit"), "{found:?}");
    assert!(serves(&found, "POST", "/profile/edit", "edit"), "{found:?}");
    assert!(serves(&found, "GET", "/profile/show", "show"), "{found:?}");
    assert!(!serves(&found, "POST", "/profile/show", "show"), "{found:?}");
}

#[test]
fn a_phoenix_scope_prefixes_the_routes_written_inside_it_however_it_nests() {
    let found = routes("phoenix_scopes");
    assert!(serves(&found, "GET", "/api/v1/orders", "index"), "{found:?}");
    assert!(serves(&found, "POST", "/api/v1/orders", "create"), "{found:?}");
    assert!(serves(&found, "GET", "/api/plugins/status", "show"), "{found:?}");
    assert!(serves(&found, "GET", "/api/health", "health"), "{found:?}");
    assert!(serves(&found, "GET", "/", "home"), "{found:?}");
}

#[test]
fn a_call_on_the_result_of_a_client_factory_is_no_served_route() {
    let found = routes("client_calls");
    assert!(!found.iter().any(|(_, path, _)| path.contains("/accounts/")), "{found:?}");
}

#[test]
fn a_route_on_the_app_is_still_served() {
    let found = routes("client_calls");
    assert!(found.iter().any(|(method, path, _)| method == "GET" && path == "/health"), "{found:?}");
}

#[test]
fn routes_in_mock_handlers_and_capitalised_test_directories_are_not_served() {
    let found = routes("client_calls");
    assert!(!found.iter().any(|(_, path, _)| path == "/api/v1/mocked" || path == "/hello"), "{found:?}");
}

#[test]
fn ktor_routes_nest_their_paths_through_route_blocks() {
    let found = routes("ktor_routes");
    let served: Vec<(&str, &str)> = found.iter().map(|(method, path, _)| (method.as_str(), path.as_str())).collect();
    assert!(served.contains(&("GET", "/health")), "{found:?}");
    assert!(served.contains(&("GET", "/api/orders")), "a verb without a path serves its enclosing route: {found:?}");
    assert!(served.contains(&("POST", "/api/orders/{id}")), "{found:?}");
}

#[test]
fn a_route_function_extending_route_serves_its_verbs() {
    let found = routes("ktor_routes");
    assert!(found.iter().any(|(method, path, _)| method == "DELETE" && path == "/orders/{id}"), "{found:?}");
}

#[test]
fn a_get_on_a_map_is_no_ktor_route() {
    let found = routes("ktor_routes");
    assert!(!found.iter().any(|(_, path, _)| path.contains("key")), "{found:?}");
    assert_eq!(found.len(), 4, "{found:?}");
}

#[test]
fn django_patterns_serve_normalised_paths_to_the_views_they_wrap() {
    let found = routes("django_routes");
    assert!(found.iter().any(|(_, path, handler)| path == "/cart/" && handler.contains("CartView")), "a wrapped class-based view is the handler: {found:?}");
    assert!(found.iter().any(|(_, path, handler)| path == "/invoices/{number}/" && handler.ends_with("invoice")), "{found:?}");
    assert!(found.iter().any(|(_, path, handler)| path == "/checkout/{order_id}/" && handler.ends_with("checkout")), "{found:?}");
}
