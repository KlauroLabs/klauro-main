mod common;

fn designs(fixture: &str) -> Vec<String> {
    let index = common::read(fixture);
    let mut held: Vec<String> = index["patterns"]["found"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|found| found["family"] == "design")
        .map(|found| found["pattern"].as_str().unwrap().to_string())
        .collect();
    held.sort();
    held
}

#[test]
fn a_class_converting_a_leaf_class_is_an_adapter_and_one_over_layers_is_a_facade() {
    assert_eq!(designs("design-patterns/adapter"), vec!["adapter", "facade"]);
}

#[test]
fn a_subscriber_registry_with_announcements_is_an_observer() {
    assert_eq!(designs("design-patterns/observer"), vec!["observer"]);
}

#[test]
fn colleagues_that_hold_their_mediator_and_are_called_by_it_are_not_adapters() {
    assert_eq!(designs("design-patterns/mediator"), vec!["mediator"]);
}

#[test]
fn a_stand_in_that_makes_its_subject_is_a_proxy_and_visit_methods_a_visitor() {
    assert_eq!(designs("design-patterns/proxy"), vec!["proxy", "visitor"]);
}

#[test]
fn services_forwarding_to_repositories_are_layers_and_not_adapters() {
    let held = designs("design-patterns/layered");
    assert!(!held.contains(&"adapter".to_string()) && !held.contains(&"facade".to_string()), "{held:?}");
}
