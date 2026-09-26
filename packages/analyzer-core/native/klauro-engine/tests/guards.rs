mod common;

use serde_json::Value;

fn guards_at(index: &Value, handler: &str) -> Vec<String> {
    let entry = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["kind"] == "http" && entry["handler"].as_str().unwrap().contains(handler))
        .unwrap_or_else(|| panic!("no route handled by {handler}"));
    entry["guards"]
        .as_array()
        .map(|held| held.iter().map(|guard| guard["kind"].as_str().unwrap().to_string()).collect())
        .unwrap_or_default()
}

#[test]
fn a_route_that_needs_whoever_is_calling_is_guarded_by_them() {
    let index = common::read("guards");
    assert_eq!(guards_at(&index, ":function:create_item"), vec!["authentication"]);
    assert_eq!(guards_at(&index, ":function:delete_item"), vec!["authorization"]);
}

#[test]
fn taking_a_login_is_not_requiring_one() {
    let index = common::read("guards");
    assert!(guards_at(&index, "items.py:function:login").is_empty());
    assert!(guards_at(&index, "orders.controller.ts:method:login").is_empty());
}

#[test]
fn a_guard_on_the_controller_guards_every_route_but_those_that_open_themselves() {
    let index = common::read("guards");
    assert_eq!(guards_at(&index, ":method:list"), vec!["authentication"]);
    assert!(guards_at(&index, ":method:receive").is_empty());
    assert_eq!(guards_at(&index, ":List"), vec!["authentication"]);
    assert!(guards_at(&index, ":Register").is_empty());
    assert_eq!(guards_at(&index, ":Remove"), vec!["authentication", "authorization", "authentication"]);
}

#[test]
fn a_guard_handed_to_a_route_is_not_itself_a_route() {
    let index = common::read("guards");
    let handlers: Vec<&str> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "http")
        .map(|entry| entry["handler"].as_str().unwrap())
        .collect();
    assert!(!handlers.iter().any(|held| held.contains("get_current_active_superuser")), "{handlers:?}");
}
