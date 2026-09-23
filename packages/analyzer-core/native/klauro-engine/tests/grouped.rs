mod common;

#[test]
fn a_route_registered_on_a_group_is_served_under_every_group_it_is_made_from() {
    let index = common::read("grouped");
    let served: Vec<String> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "http")
        .map(|entry| format!("{} {}", entry["method"].as_str().unwrap(), entry["path"].as_str().unwrap()))
        .collect();
    assert_eq!(served, vec!["GET /api/v1/items"]);
}
