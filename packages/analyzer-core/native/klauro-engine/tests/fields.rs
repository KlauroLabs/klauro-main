mod common;

fn reached_from(fixture: &str, caller: &str) -> Vec<String> {
    let index = common::read(fixture);
    let caller = index["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["name"] == caller)
        .map(|node| node["id"].as_str().unwrap().to_string())
        .unwrap();
    index["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|edge| edge["source"] == caller.as_str() && edge["kind"] == "calls")
        .map(|edge| edge["target"].as_str().unwrap().to_string())
        .collect()
}

fn fields(fixture: &str) -> Vec<(String, String)> {
    let index = common::read(fixture);
    index["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|node| node["kind"] == "property")
        .map(|node| {
            (
                node["name"].as_str().unwrap().to_string(),
                node["type_annotation"].as_str().unwrap_or("").to_string(),
            )
        })
        .collect()
}

#[test]
fn a_field_is_named_for_itself_and_typed_by_its_declaration() {
    let held = fields("fields/csharp");
    assert!(held.contains(&("_orderRepository".to_string(), "IOrderRepository".to_string())), "{held:?}");
    let held = fields("fields/java");
    assert!(held.contains(&("orderRepository".to_string(), "OrderRepository".to_string())), "{held:?}");
}

#[test]
fn a_call_through_a_typed_field_reaches_the_member_it_names() {
    let reached = reached_from("fields/csharp", "Handle");
    assert!(reached.iter().any(|target| target.ends_with(":function:Add")), "{reached:?}");
    let reached = reached_from("fields/java", "handle");
    assert!(reached.iter().any(|target| target.ends_with(":function:add")), "{reached:?}");
}
