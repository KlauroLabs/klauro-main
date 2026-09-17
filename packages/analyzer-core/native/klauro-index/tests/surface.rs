mod common;

fn index() -> serde_json::Value {
    common::read("surface")
}

fn entry<'a>(index: &'a serde_json::Value, name: &str) -> Option<&'a serde_json::Value> {
    index["entry_points"].as_array().unwrap().iter().find(|entry| entry["name"] == name)
}

#[test]
fn a_resolver_inherits_its_surface_through_a_repository_base_class() {
    let index = index();
    let found = entry(&index, "resolve_name").expect("the resolver is an entry point");
    assert_eq!(found["kind"], "graphql");
    assert!(
        entry(&index, "helper").is_none(),
        "only the members the base type serves are entry points"
    );
}

#[test]
fn a_framework_component_is_an_entry_point_and_a_plain_class_is_not() {
    let index = index();
    let found = entry(&index, "MainActivity").expect("the activity is an entry point");
    assert_eq!(found["kind"], "lifecycle");
    assert!(entry(&index, "Helper").is_none(), "a class with no framework base is not served");
}

#[test]
fn a_manager_receiver_makes_a_query_a_database_exit() {
    let index = index();
    let exits = index["exit_points"].as_array().unwrap();
    let found = exits
        .iter()
        .find(|exit| exit["operation"] == "filter")
        .expect("the manager query is an exit point");
    assert_eq!(found["kind"], "database");
}
