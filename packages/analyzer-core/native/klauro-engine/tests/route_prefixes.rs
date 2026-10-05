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
                entry["method"].as_str().unwrap_or("ANY").to_string(),
                entry["path"].as_str().unwrap_or_default().to_string(),
                entry["handler"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

fn serves(found: &[(String, String, String)], method: &str, path: &str, handler: &str) -> bool {
    found
        .iter()
        .any(|(held_method, held_path, held_handler)| held_method == method && held_path == path && held_handler.contains(handler))
}

#[test]
fn an_included_router_adds_the_prefix_of_every_router_above_it_across_files() {
    let found = routes("prefix_fastapi");
    assert!(serves(&found, "GET", "/api/v1/items", "read_items"), "{found:?}");
    assert!(serves(&found, "GET", "/api/v1/items/{item_id}", "read_item"), "{found:?}");
    assert!(serves(&found, "POST", "/api/v1/login/access-token", "login_access_token"), "{found:?}");
}

#[test]
fn an_express_router_required_or_imported_takes_the_path_it_was_used_at() {
    let found = routes("prefix_express");
    assert!(serves(&found, "GET", "/api/users/:id", "router.get"), "{found:?}");
    assert!(serves(&found, "POST", "/api/users", "router.post"), "{found:?}");
    assert!(serves(&found, "GET", "/api/orders/recent", "router.get"), "{found:?}");
    assert!(serves(&found, "GET", "/health", "app.get"), "the app's own route keeps its path: {found:?}");
}

#[test]
fn a_nested_axum_router_adds_its_path_to_the_routes_of_the_module_it_comes_from() {
    let found = routes("prefix_axum");
    assert!(serves(&found, "GET", "/api/users", "list_users"), "{found:?}");
    assert!(serves(&found, "GET", "/health", "health"), "{found:?}");
}

#[test]
fn one_axum_route_chaining_two_methods_serves_each_handler_under_its_own_method() {
    let found = routes("prefix_axum");
    assert!(serves(&found, "GET", "/api/users/:id", "show_user"), "{found:?}");
    assert!(serves(&found, "POST", "/api/users/:id", "update_user"), "{found:?}");
}

#[test]
fn rails_namespaces_and_scopes_prefix_routes_to_controllers_inside_modules() {
    let found = routes("prefix_rails");
    assert!(serves(&found, "GET", "/admin/users", "index"), "{found:?}");
    assert!(serves(&found, "GET", "/admin/users/:id", "show"), "{found:?}");
    assert!(serves(&found, "GET", "/admin/stats", "show"), "{found:?}");
    assert!(serves(&found, "GET", "/v1/ping", "ping"), "{found:?}");
    assert!(serves(&found, "GET", "/api/orders", "index"), "a drawn routes file keeps its namespace: {found:?}");
}

#[test]
fn a_fastify_plugin_registered_with_a_prefix_serves_its_routes_under_it() {
    let found = routes("prefix_fastify");
    assert!(serves(&found, "GET", "/v1/ping", "instance.get"), "an inline plugin: {found:?}");
    assert!(serves(&found, "GET", "/users/:id", "get"), "a plugin required from another file: {found:?}");
    assert!(serves(&found, "POST", "/users", "post"), "{found:?}");
    assert!(serves(&found, "GET", "/health", "get"), "the app's own route keeps its path: {found:?}");
}

#[test]
fn swift_route_groups_prefix_their_routes_within_a_function_across_functions_and_through_a_collection() {
    let found = routes("prefix_vapor");
    assert!(serves(&found, "GET", "/health", "get"), "{found:?}");
    assert!(serves(&found, "GET", "/api/v1/ping", "get"), "a group made in the same function: {found:?}");
    assert!(serves(&found, "GET", "/api/v1/todos", "get"), "a group handed to another function: {found:?}");
    assert!(serves(&found, "POST", "/api/v1/todos", "post"), "{found:?}");
    assert!(serves(&found, "GET", "/api/v1/items", "index"), "a collection registered on a group: {found:?}");
    assert!(serves(&found, "GET", "/api/v1/items/:id", "show"), "{found:?}");
}
