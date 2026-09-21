mod common;

fn index() -> serde_json::Value {
    common::read("icelot")
}

fn unit<'a>(index: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
    index["icelot"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["unit"].as_str().unwrap().contains(name))
        .unwrap_or_else(|| panic!("{name} has an ICELOT entry"))
}

#[test]
fn a_unit_that_does_nothing_carries_no_facets() {
    let index = index();
    let found = unit(&index, "function:nothing");
    let facets: Vec<&String> = found.as_object().unwrap().keys().collect();
    assert_eq!(facets, vec!["unit"], "artificial completeness is forbidden: {facets:?}");
}

#[test]
fn effects_name_the_integrations_a_unit_reaches() {
    let index = index();
    let found = unit(&index, "function:fetchUser");
    let integrations = found["effects"]["integrations"].as_array().unwrap();
    assert!(
        integrations.iter().any(|reached| *reached == "package:axios"),
        "the package reached is named, not counted: {integrations:?}"
    );
}

#[test]
fn input_and_output_come_from_the_signature() {
    let index = index();
    let found = unit(&index, "function:fetchUser");
    assert_eq!(found["input"]["types"][0], "string");
    assert_eq!(found["output"]["return_type"], "Promise<string>");
    assert!(!found["constraints"]["throws"].as_array().unwrap().is_empty());
}
