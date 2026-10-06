mod common;

fn served(fixture: &str) -> Vec<(String, String, String)> {
    let index = common::read(fixture);
    let mut found: Vec<(String, String, String)> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "http")
        .map(|entry| {
            (
                entry["method"].as_str().unwrap_or_default().to_string(),
                entry["path"].as_str().unwrap().to_string(),
                entry["handler"].as_str().unwrap().rsplit(':').next().unwrap().to_string(),
            )
        })
        .collect();
    found.sort();
    found
}

#[test]
fn a_path_named_earlier_in_a_fluent_router_chain_is_the_route_of_the_handler_it_ends_in() {
    assert_eq!(
        served("chained-routes"),
        vec![
            ("GET".to_string(), "/api/overview".to_string(), "getOverview".to_string()),
            ("PUT".to_string(), "/api/providers/{provider}".to_string(), "putProvider".to_string()),
        ]
    );
}

#[test]
fn an_options_object_is_not_a_handler_and_a_bound_result_is_not_a_route() {
    assert_eq!(served("option-bag-routes").len(), 1, "{:?}", served("option-bag-routes"));
    let found = served("option-bag-routes");
    assert_eq!(found[0].0, "GET");
    assert_eq!(found[0].1, "/await");
    assert!(!found[0].2.contains("schema"), "{found:?}");
}

#[test]
fn a_python_module_imported_by_a_dotted_name_is_reached_through_its_first_segment() {
    let index = common::read("py-urlopen");
    let reaches = index["exit_points"]
        .as_array()
        .unwrap()
        .iter()
        .any(|exit| exit["kind"] == "api" && exit["operation"] == "urlopen");
    assert!(reaches, "{:?}", index["exit_points"]);
}
