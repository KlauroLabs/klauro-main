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
        .find(|flow| flow["operation"].as_str().unwrap().contains("store"))
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
fn no_capability_exists_without_a_model_to_form_it() {
    let index = index();
    let capabilities = index["comprehension"]["capabilities"].as_array().unwrap();
    assert!(
        capabilities.is_empty(),
        "capabilities are formed by a model or not at all: {capabilities:?}"
    );
}

#[test]
fn no_member_carries_a_name_or_a_description_without_a_model() {
    let index = index();
    let comprehension = &index["comprehension"];
    let members: Vec<&serde_json::Value> = ["flows", "entities"]
        .into_iter()
        .flat_map(|member| comprehension[member].as_array().unwrap())
        .collect();
    assert!(!members.is_empty(), "the fixture holds members to check");
    let written: Vec<&&serde_json::Value> = members
        .iter()
        .filter(|member| !member["name"].is_null() || !member["description"].is_null())
        .collect();
    assert!(
        written.is_empty(),
        "comprehension is authored or absent, never derived: {written:?}"
    );
}
