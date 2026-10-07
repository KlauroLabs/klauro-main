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
    assert_eq!(found["kind"], "ui", "an activity is a screen its user reaches");
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

fn exit<'a>(index: &'a serde_json::Value, name: &str) -> Option<&'a serde_json::Value> {
    index["exit_points"].as_array().unwrap().iter().find(|exit| exit["name"] == name)
}

#[test]
fn a_qualified_call_into_a_standard_module_is_an_exit() {
    let index = index();
    assert_eq!(exit(&index, "fs::read_to_string").map(|found| &found["kind"]), Some(&serde_json::json!("file")));
    assert!(exit(&index, "fs::metadata").is_some(), "a stat still leaves the process");
}

#[test]
fn a_static_io_type_is_an_exit_but_a_path_helper_is_not() {
    let index = index();
    assert_eq!(exit(&index, "File.ReadAllBytes").map(|found| &found["kind"]), Some(&serde_json::json!("file")));
    assert!(
        exit(&index, "Path.GetFileName").is_none(),
        "building a path string never leaves the process"
    );
}

#[test]
fn a_generated_query_object_is_a_database_exit() {
    let index = index();
    let found = exit(&index, "db.showQueries.entriesInPage").expect("the query is an exit");
    assert_eq!(found["kind"], "database");
}

#[test]
fn a_chained_query_crosses_the_boundary_once() {
    let index = index();
    let queries: Vec<&serde_json::Value> = index["exit_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|exit| exit["operation"] == "query")
        .collect();
    assert_eq!(queries.len(), 2, "one exit per query site, not one per chained link");
    assert!(queries.iter().all(|exit| exit["name"] == "session.query"));
}

#[test]
fn a_command_line_framework_s_declared_commands_are_entries_and_nothing_else() {
    let index = common::read("thor_commands");
    let commands: Vec<&str> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "cli")
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    assert_eq!(commands, vec!["create"], "only what desc declares is a command, and a model sharing a base's short name is none");
}

#[test]
fn a_framework_base_is_not_reached_through_a_repository_type_that_shares_its_short_name() {
    let index = common::read("thor_commands");
    let background: Vec<&str> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "background")
        .map(|entry| entry["handler"].as_str().unwrap())
        .collect();
    assert!(background.is_empty(), "a model under ActiveRecord::Base is no job though Jobs::Base is: {background:?}");
}
