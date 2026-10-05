mod common;

#[test]
fn a_ruby_verb_with_a_path_and_a_block_serves_that_path() {
    let index = common::read("sinatra_routes");
    let mut served: Vec<(String, String)> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "http")
        .map(|entry| (entry["method"].as_str().unwrap().to_string(), entry["path"].as_str().unwrap().to_string()))
        .collect();
    served.sort();
    assert_eq!(
        served,
        vec![
            ("DELETE".to_string(), "/users/:id".to_string()),
            ("GET".to_string(), "/users".to_string()),
            ("POST".to_string(), "/users".to_string()),
        ]
    );
}
