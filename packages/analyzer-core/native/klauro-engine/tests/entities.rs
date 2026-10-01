mod common;

use serde_json::Value;

fn entities(fixture: &str) -> Vec<Value> {
    common::read(fixture)["comprehension"]["entities"].as_array().unwrap().clone()
}

fn named(held: &[Value]) -> Vec<&str> {
    let mut names: Vec<&str> = held.iter().filter_map(|entity| entity["declared_as"].as_str()).collect();
    names.sort();
    names
}

fn strings(value: &Value) -> Vec<&str> {
    value.as_array().map(|held| held.iter().filter_map(Value::as_str).collect()).unwrap_or_default()
}

#[test]
fn a_type_persisted_through_a_file_is_a_record_and_the_option_bags_and_props_beside_it_are_not() {
    let held = entities("entities/kept");
    assert_eq!(named(&held), vec!["AccountUser", "AccountWorkspace"]);
}

#[test]
fn a_record_is_linked_to_the_flows_that_write_it_and_the_flows_that_read_it() {
    let index = common::read("entities/kept");
    let entities = index["comprehension"]["entities"].as_array().unwrap();
    let flows = index["comprehension"]["flows"].as_array().unwrap();
    let workspace = entities.iter().find(|entity| entity["declared_as"] == "AccountWorkspace").unwrap();
    let writing = strings(&workspace["written_in"]);
    let reading = strings(&workspace["read_in"]);
    assert!(writing.iter().any(|id| id.contains("app.post@#2")), "{writing:?}");
    assert!(reading.iter().any(|id| id.contains("app.get")), "{reading:?}");
    assert!(!workspace["written_by"].as_array().unwrap().is_empty());
    assert!(!workspace["read_by"].as_array().unwrap().is_empty());
    let registering = flows.iter().find(|flow| flow["id"].as_str().is_some_and(|id| id.contains("app.post@#1") && !id.ends_with("published"))).unwrap();
    assert_eq!(strings(&registering["writes"]), vec!["AccountUser"]);
    let listing = flows.iter().find(|flow| flow["id"] == "flow:entry:src/server.ts:callback:app.get").unwrap();
    assert_eq!(strings(&listing["reads"]), vec!["AccountWorkspace"]);
    assert_eq!(workspace["project"], registering["project"]);
}

#[test]
fn a_record_kept_by_a_part_belongs_to_that_part() {
    for entity in entities("entities/kept") {
        assert_eq!(entity["project"], "subproject:kept", "{entity}");
    }
}

#[test]
fn the_bodies_an_entry_point_takes_and_gives_are_records_and_a_plain_helper_shape_is_not() {
    let held = entities("entities/contract");
    assert_eq!(named(&held), vec!["CreateOrderDto", "OrderView"]);
}

#[test]
fn a_serde_struct_an_ipc_command_takes_or_gives_is_a_record_and_a_plain_struct_is_not() {
    let held = entities("entities/wire");
    assert_eq!(named(&held), vec!["Draft", "Note"]);
}

#[test]
fn a_request_body_is_written_by_the_flow_that_takes_it() {
    let index = common::read("entities/contract");
    let flows = index["comprehension"]["flows"].as_array().unwrap();
    let creating = flows.iter().find(|flow| flow["id"].as_str().is_some_and(|id| id.contains("method:create"))).unwrap();
    assert_eq!(strings(&creating["writes"]), vec!["CreateOrderDto"]);
    assert_eq!(strings(&creating["reads"]), vec!["OrderView"]);
}
