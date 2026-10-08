mod common;

fn built_by(index: &serde_json::Value, unit: &str) -> Vec<String> {
    index["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|edge| edge["kind"] == "instantiates" && edge["source"].as_str().is_some_and(|source| source.ends_with(unit)))
        .map(|edge| edge["target"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn a_type_named_in_several_namespaces_is_the_one_the_file_imports_itself_before_the_ones_imported_everywhere() {
    let index = common::read("namespaced_types");
    assert_eq!(built_by(&index, "PlaceOrder.cs:function:Handle"), vec!["Domain/Order.cs:type:Order"]);
    assert_eq!(built_by(&index, "RefundOrder.cs:function:Handle"), vec!["Queries/OrderView.cs:type:Order"]);
}

#[test]
fn a_member_typed_by_its_full_name_reaches_the_type_in_that_namespace() {
    let index = common::read("namespaced_types");
    let reached: Vec<&str> = index["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|edge| edge["kind"] == "calls" && edge["source"].as_str().is_some_and(|source| source.ends_with("Closing.cs:function:Finish")))
        .filter_map(|edge| edge["target"].as_str())
        .collect();
    assert!(reached.contains(&"Domain/Order.cs:function:Close"), "{reached:?}");
}
