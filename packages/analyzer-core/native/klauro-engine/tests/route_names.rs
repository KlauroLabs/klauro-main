mod common;

#[test]
fn a_chained_axum_route_keeps_its_method_out_of_its_path_in_its_name() {
    let index = common::read("axum-chained-route");
    let served: Vec<(&str, &str, &str)> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "http")
        .map(|entry| (entry["name"].as_str().unwrap(), entry["method"].as_str().unwrap(), entry["path"].as_str().unwrap()))
        .collect();
    assert!(!served.is_empty());
    for (name, method, path) in served {
        assert_eq!((name, method, path), ("POST /mcp/{chat_id}", "POST", "/mcp/{chat_id}"));
    }
}

#[test]
fn a_package_built_for_publication_with_no_entry_points_is_a_library() {
    let index = common::read("published-python");
    let projects = index["partition"]["sub_projects"].as_array().unwrap();
    assert!(projects.iter().any(|project| project["status"] == "library"), "{projects:?}");
}
