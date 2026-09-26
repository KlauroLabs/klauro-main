mod common;

fn untested(index: &serde_json::Value) -> Vec<String> {
    index["verification"]["gaps"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|gap| gap["gap"] == "untested-surface")
        .map(|gap| gap["node"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn a_route_asked_for_under_a_prefix_the_test_names_is_tested() {
    let index = common::read("asked");
    let untested = untested(&index);
    assert!(!untested.iter().any(|node| node.ends_with(":function:read_item")), "{untested:?}");
    assert!(untested.iter().any(|node| node.ends_with(":function:delete_item")), "{untested:?}");
}
