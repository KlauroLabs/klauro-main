mod common;

#[test]
fn a_client_typed_by_a_namespace_the_project_opens_everywhere_reaches_its_service() {
    let index = common::read("clients");
    let reached: Vec<(String, String)> = index["exit_points"]
        .as_array()
        .unwrap()
        .iter()
        .map(|exit| {
            (exit["operation"].as_str().unwrap_or("").to_string(), exit["service"].as_str().unwrap_or("").to_string())
        })
        .collect();
    assert!(reached.contains(&("KeyDeleteAsync".to_string(), "Redis".to_string())), "{reached:?}");
}
