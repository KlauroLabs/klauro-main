mod common;

fn index() -> serde_json::Value {
    common::read("verified")
}

#[test]
fn a_served_surface_is_a_flow_with_the_steps_it_runs() {
    let index = index();
    let flows = index["comprehension"]["flows"].as_array().unwrap();
    let reading = flows
        .iter()
        .find(|flow| flow["name"].as_str().unwrap().contains("stores"))
        .expect("the route is a flow");
    assert!(reading["units"].as_u64().unwrap() >= 2, "{reading}");
    assert!(!reading["steps"].as_array().unwrap().is_empty(), "{reading}");
}

#[test]
fn a_flow_that_changes_nothing_is_not_terminal() {
    let index = index();
    let flows = index["comprehension"]["flows"].as_array().unwrap();
    assert!(
        flows.iter().all(|flow| flow["standing"] != "terminal"
            || !flow["changes"].as_array().unwrap().is_empty()),
        "a terminal flow names what it changes"
    );
}

#[test]
fn an_entity_is_a_type_the_code_stores_rather_than_any_type_with_fields() {
    let index = index();
    let entities = index["comprehension"]["entities"].as_array().unwrap();
    assert!(
        entities.iter().all(|entity| entity["fields"].as_u64().unwrap() >= 1),
        "{entities:?}"
    );
}

#[test]
fn nothing_is_named_without_a_model() {
    let index = index();
    let named: Vec<&serde_json::Value> = index["comprehension"]["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .chain(index["comprehension"]["entities"].as_array().unwrap())
        .filter(|member| !member["description"].is_null())
        .collect();
    assert!(named.is_empty(), "a run without a key authors nothing: {named:?}");
}
