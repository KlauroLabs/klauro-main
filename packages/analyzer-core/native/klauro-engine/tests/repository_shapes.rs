mod common;

use serde_json::Value;

fn only_part(index: &Value) -> &Value {
    let parts = index["partition"]["sub_projects"].as_array().unwrap();
    assert_eq!(parts.len(), 1, "a repository of one unit is one part: {parts:#?}");
    &parts[0]
}

fn entries<'a>(index: &'a Value, kind: &str) -> Vec<&'a str> {
    let mut found: Vec<&str> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == kind)
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    found.sort();
    found
}

#[test]
fn a_folder_of_pages_is_a_website_named_for_its_repository() {
    let index = common::read("shape_site");
    let part = only_part(&index);
    assert_eq!(part["role"], "website");
    assert_eq!(part["display_name"], "Shape site");
    assert_eq!(entries(&index, "ui"), vec!["/", "/about"]);
}

#[test]
fn a_folder_of_scripts_is_a_tool_whose_scripts_and_commands_are_its_entries() {
    let index = common::read("shape_scripts");
    assert_eq!(only_part(&index)["role"], "tool");
    assert_eq!(entries(&index, "cli"), vec!["backup", "cleanup", "daily", "weekly"]);
}

#[test]
fn a_command_line_package_is_a_tool_whose_commands_are_its_entries() {
    let index = common::read("shape_cli");
    assert_eq!(only_part(&index)["role"], "tool");
    assert_eq!(entries(&index, "cli"), vec!["add", "list"]);
}
