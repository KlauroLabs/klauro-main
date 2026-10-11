mod common;

#[test]
fn routes_declared_in_route_table_attributes_are_served_under_the_paths_their_tables_are_mounted_at() {
    let index = common::read("rust_route_tables");
    let mut served: Vec<String> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "http")
        .map(|entry| format!("{} {} {}", entry["method"].as_str().unwrap_or("-"), entry["path"].as_str().unwrap_or("-"), entry["handler"].as_str().unwrap_or("-").rsplit(':').next().unwrap_or("-")))
        .collect();
    served.sort();
    assert_eq!(served, ["DELETE /keys/{key} delete_key", "GET /health get_health", "GET /keys list_keys", "GET /keys/{key} get_key", "POST /keys create_key"], "{served:?}");
}
