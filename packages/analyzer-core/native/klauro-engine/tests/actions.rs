mod common;

fn flow_of<'a>(index: &'a serde_json::Value, named: &str) -> &'a serde_json::Value {
    index["comprehension"]["flows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|flow| flow["operation"] == named)
        .unwrap_or_else(|| panic!("{named} is a flow"))
}

fn reached(flow: &serde_json::Value) -> Vec<&str> {
    flow["path"].as_array().unwrap().iter().map(|step| step["unit"].as_str().unwrap()).collect()
}

#[test]
fn each_arm_of_a_screen_event_is_an_action_a_person_takes() {
    let index = common::read("actions");
    let taken: Vec<&str> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "ui")
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    assert!(taken.contains(&"ShelfUiEvent.Keep"), "{taken:?}");
    assert!(taken.contains(&"ShelfUiEvent.Close"), "{taken:?}");
}

#[test]
fn a_protocol_match_in_plain_code_is_not_an_action() {
    let index = common::read("actions");
    let named: Vec<&str> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    assert!(!named.iter().any(|held| held.contains("Ping")), "{named:?}");
}

#[test]
fn an_action_follows_an_injected_interactor_to_the_one_store_that_keeps_it() {
    let index = common::read("actions");
    let units = reached(flow_of(&index, "ShelfUiEvent.Keep"));
    assert!(units.iter().any(|unit| unit.ends_with("KeepBook.kt:function:doWork")), "{units:?}");
    assert!(units.iter().any(|unit| unit.ends_with("ShelfDao.kt:function:keep@SqlShelfDao")), "{units:?}");
}
