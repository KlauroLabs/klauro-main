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
