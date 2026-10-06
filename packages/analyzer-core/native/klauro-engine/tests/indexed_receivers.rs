mod common;

fn callees(index: &serde_json::Value, caller: &str) -> Vec<String> {
    index["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|edge| edge["kind"] == "calls" && edge["source"].as_str().is_some_and(|source| common::names(source, caller)))
        .map(|edge| edge["target"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn a_call_on_a_value_read_from_a_record_of_an_interface_reaches_its_method() {
    let index = common::read("indexed_receivers");
    let reached = callees(&index, "pushThroughRecord");
    assert!(reached.iter().any(|target| target.contains("send@Sender")), "{reached:?}");
}

#[test]
fn a_call_on_a_value_read_from_a_map_of_an_interface_reaches_its_method() {
    let index = common::read("indexed_receivers");
    let reached = callees(&index, "pushThroughMap");
    assert!(reached.iter().any(|target| target.contains("send@Sender")), "{reached:?}");
}

#[test]
fn a_constructor_parameter_property_defaulting_to_a_function_is_called_through_its_field() {
    let index = common::read("indexed_receivers");
    let exits: Vec<&str> = index["exit_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|exit| exit["source"].as_str().is_some_and(|source| source.ends_with("send@ExpoSender")))
        .filter_map(|exit| exit["target"].as_str())
        .collect();
    assert_eq!(exits, vec!["fetch"]);
}

#[test]
fn the_interface_method_reaches_each_implementer_by_rule() {
    let index = common::read("indexed_receivers");
    let rules: Vec<&str> = index["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|edge| edge["via"] == "rule" && edge["source"].as_str().is_some_and(|source| source.ends_with("send@Sender")))
        .filter_map(|edge| edge["target"].as_str())
        .collect();
    assert_eq!(rules.len(), 2, "{rules:?}");
}
