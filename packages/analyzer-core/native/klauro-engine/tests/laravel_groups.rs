mod common;

fn routes() -> Vec<(String, String, String)> {
    let index = common::read("laravel_groups");
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
fn a_prefixed_group_prefixes_the_routes_written_inside_it() {
    let found = routes();
    assert!(serves(&found, "GET", "/vaults/{vault}", "show"), "{found:?}");
}

#[test]
fn a_group_nested_in_a_group_adds_its_prefix_to_the_one_above() {
    let found = routes();
    assert!(serves(&found, "GET", "/vaults/{vault}/edit", "edit"), "{found:?}");
}

#[test]
fn an_empty_path_is_the_index_of_its_group() {
    let found = routes();
    assert!(serves(&found, "GET", "/vaults", "index"), "{found:?}");
}

#[test]
fn a_route_whose_arguments_span_lines_keeps_its_group() {
    let found = routes();
    assert!(serves(&found, "POST", "/vaults", "store"), "{found:?}");
}

#[test]
fn a_resource_expands_to_the_actions_its_controller_declares() {
    let found = routes();
    assert!(serves(&found, "GET", "/photos/create", "create"), "{found:?}");
    assert!(serves(&found, "PUT", "/photos/{photo}", "update"), "{found:?}");
    assert!(serves(&found, "PATCH", "/photos/{photo}", "update"), "{found:?}");
    assert!(serves(&found, "DELETE", "/photos/{photo}", "destroy"), "{found:?}");
}

#[test]
fn an_api_resource_restricted_by_only_serves_just_those_actions() {
    let found = routes();
    assert!(serves(&found, "GET", "/items", "index"), "{found:?}");
    assert!(serves(&found, "GET", "/items/{item}", "show"), "{found:?}");
    assert!(!found.iter().any(|(_, path, _)| path.starts_with("/items") && path != "/items" && path != "/items/{item}"), "{found:?}");
    assert!(!serves(&found, "POST", "/items", "store"), "{found:?}");
}
