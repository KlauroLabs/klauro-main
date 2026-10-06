mod common;

#[test]
fn a_route_option_that_mentions_authorization_is_no_guard() {
    let index = common::read("route_options");
    let guarded: Vec<String> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "http")
        .flat_map(|entry| entry["guards"].as_array().into_iter().flatten().map(|guard| guard["name"].as_str().unwrap().to_string()))
        .collect();
    assert!(guarded.is_empty(), "{guarded:?}");
}
