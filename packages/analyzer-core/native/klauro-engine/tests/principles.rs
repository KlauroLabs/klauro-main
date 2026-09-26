mod common;

use serde_json::Value;

fn principle<'a>(index: &'a Value, named: &str) -> &'a Value {
    index["principles"]["solid"].as_array().unwrap().iter().find(|held| held["principle"] == named).unwrap()
}

#[test]
fn an_override_that_refuses_its_base_departs_from_substitution() {
    let index = common::read("principles");
    let held = principle(&index, "substitutable implementations");
    assert_eq!((held["following"].as_u64(), held["population"].as_u64()), (Some(1), Some(2)));
    assert!(held["departing"][0].as_str().unwrap().starts_with("app/shapes.py:function:scale"));
}

#[test]
fn a_service_holding_a_concrete_repository_departs_from_inversion() {
    let index = common::read("principles");
    let held = principle(&index, "dependency inversion");
    assert_eq!((held["following"].as_u64(), held["population"].as_u64()), (Some(0), Some(1)));
    assert!(held["departing"][0].as_str().unwrap().ends_with("depends on concrete OrderRepository"));
    let open = principle(&index, "open for extension");
    assert_eq!(open["departing"][0], "0 extension points with two or more implementations");
}

#[test]
fn files_that_import_each_other_are_a_cycle() {
    let index = common::read("principles");
    let cycles: Vec<&Value> = index["principles"]["anti_patterns"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|held| held["anti_pattern"] == "circular dependency")
        .collect();
    assert_eq!(cycles.len(), 1);
    assert_eq!(cycles[0]["examples"][0], "2 files import each other in a cycle: app/orders.py, app/shapes.py");
}
