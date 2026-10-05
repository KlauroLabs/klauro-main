mod common;

use serde_json::Value;

fn entries(index: &Value) -> Vec<&Value> {
    index["entry_points"].as_array().unwrap().iter().collect()
}

#[test]
fn a_literal_handed_to_a_plain_helper_is_not_a_route() {
    let index = common::read("desktop-noise");
    assert!(entries(&index).iter().all(|entry| entry["kind"] != "http"), "{:?}", entries(&index));
}

#[test]
fn a_program_started_only_by_tests_is_set_aside_as_tooling() {
    let index = common::read("desktop-noise");
    let program = entries(&index)
        .into_iter()
        .find(|entry| entry["kind"] == "lifecycle" && entry["name"] == "main" && entry["id"].as_str().unwrap().contains("fake_cli"))
        .expect("the fake program has a main");
    assert_eq!(program["unshipped"]["basis"], "test-only-reach");
    let product = entries(&index)
        .into_iter()
        .find(|entry| entry["kind"] == "lifecycle" && entry["id"].as_str().unwrap().contains("src/main.rs"))
        .expect("the application has a main");
    assert!(product["unshipped"].is_null());
}

#[test]
fn a_desktop_command_is_read_down_through_its_store() {
    let index = common::read("desktop-noise");
    let paths: Vec<Vec<String>> = index["layering"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|layering| layering["paths"].as_array().unwrap().clone())
        .map(|path| path["layers"].as_array().unwrap().iter().map(|layer| layer.as_str().unwrap().to_string()).collect())
        .collect();
    assert!(
        paths.iter().any(|layers| layers.starts_with(&["ipc entry".to_string(), "handler".to_string(), "repository".to_string()])),
        "{paths:?}"
    );
}

#[test]
fn components_and_hooks_take_their_place_in_the_roles() {
    let index = common::read("desktop-noise");
    let roles: Vec<(String, String)> = index["roles"]["roles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|role| (role["node"].as_str().unwrap().to_string(), role["role"].as_str().unwrap().to_string()))
        .collect();
    let has = |name: &str, role: &str| roles.iter().any(|(node, held)| node.ends_with(name) && held == role);
    assert!(has("NoteEditor", "component"), "{roles:?}");
    assert!(has("useNote", "service"), "{roles:?}");
}

#[test]
fn a_closure_inside_a_channel_arm_is_declared_once_under_that_arm() {
    let index = common::read("channel-closures");
    let mut seen = std::collections::HashSet::new();
    for node in index["nodes"].as_array().unwrap() {
        let id = node["id"].as_str().unwrap();
        assert!(seen.insert(id.to_string()), "{id} is declared twice");
    }
}

#[test]
fn a_function_handed_to_a_call_by_name_is_reached_from_the_function_that_hands_it() {
    let index = common::read("function_handed_as_argument");
    assert!(common::calls(&index, "src/main.rs:function:main", "src/main.rs:function:read_it"));
    assert!(common::calls(&index, "src/main.rs:function:main", "src/main.rs:function:parse"));
    assert!(common::calls(&index, "src/schedule.ts:function:start", "src/schedule.ts:function:tick"));
    assert!(!common::calls(&index, "src/schedule.ts:function:start", "src/schedule.ts:function:refresh"));
}
