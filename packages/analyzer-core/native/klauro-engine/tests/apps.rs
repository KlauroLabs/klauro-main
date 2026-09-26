mod common;

fn category_of(index: &serde_json::Value, root: &str) -> Option<String> {
    index["scope"]["deployables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|unit| unit["root"] == root)
        .map(|unit| unit["category"].as_str().unwrap().to_string())
}

#[test]
fn a_library_module_holding_a_receiver_is_not_something_that_runs_on_its_own() {
    let index = common::read("apps");
    assert_eq!(category_of(&index, "tasks").as_deref(), Some("library"));
}

#[test]
fn a_desktop_application_block_ships_the_module() {
    let index = common::read("apps");
    assert_eq!(category_of(&index, "desktop").as_deref(), Some("shipped"));
}

#[test]
fn an_app_marked_main_beside_its_xcode_project_ships() {
    let index = common::read("apps");
    assert_eq!(category_of(&index, "ios/Shelf").as_deref(), Some("shipped"));
}
