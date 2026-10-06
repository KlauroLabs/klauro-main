mod common;

#[test]
fn a_subrouter_under_a_prefix_the_source_does_not_spell_still_serves_its_routes() {
    let index = common::read("subrouter_prefix");
    let mut served: Vec<String> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "http")
        .map(|entry| format!("{} {}", entry["method"].as_str().unwrap_or_default(), entry["path"].as_str().unwrap()))
        .collect();
    served.sort();
    assert_eq!(served, vec!["GET /api/overview", "GET /api/rawdata"]);
}
