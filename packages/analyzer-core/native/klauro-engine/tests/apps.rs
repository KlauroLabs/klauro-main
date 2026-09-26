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

#[test]
fn a_module_an_app_depends_on_is_bundled_into_it_and_offers_nothing_of_its_own() {
    let index = common::read("apps");
    let tasks = index["scope"]["deployables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|unit| unit["root"] == "tasks")
        .unwrap();
    assert_eq!(tasks["bundled_into"], "deployable:desktop");
    let offered = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "export" && entry["handler"].as_str().unwrap().starts_with("tasks/"))
        .count();
    assert_eq!(offered, 0);
}
