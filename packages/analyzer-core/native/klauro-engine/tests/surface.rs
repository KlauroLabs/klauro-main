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

#[test]
fn a_razor_page_is_a_screen_at_its_route() {
    let index = common::read("razor_pages");
    let mut screens: Vec<&str> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "ui")
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    screens.sort();
    assert_eq!(screens, vec!["/", "/item/{itemId:int}"]);
    assert!(index["entry_points"].as_array().unwrap().iter().all(|entry| entry["kind"] != "http"), "a page is never an HTTP route");
}

#[test]
fn a_view_bound_to_a_model_loads_through_it_and_each_bound_command_is_an_action() {
    let index = common::read("mvvm_views");
    let mut actions: Vec<&str> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["registrar"] == "binding")
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    actions.sort();
    assert_eq!(actions, vec!["OrdersView.CancelOrder", "OrdersView.Checkout", "OrdersView.Refresh"]);
    let flows = index["comprehension"]["flows"].as_array().unwrap();
    let screen = flows.iter().find(|flow| flow["operation"] == "OrdersView").expect("the screen is a flow");
    assert!(screen["path"].as_array().unwrap().iter().any(|step| step["unit"].as_str().unwrap().contains("InitializeAsync")), "{screen}");
    assert!(
        screen["steps"].as_array().unwrap().iter().all(|step| !step["label"].as_str().unwrap_or_default().contains("property")),
        "property-change notification is plumbing: {screen}"
    );
}

#[test]
fn an_action_calls_out_through_a_client_its_own_code_made_and_then_goes_to_a_screen() {
    let index = common::read("mvvm_views");
    let flows = index["comprehension"]["flows"].as_array().unwrap();
    let checkout = flows.iter().find(|flow| flow["operation"] == "OrdersView.Checkout").expect("the action is a flow");
    let steps: Vec<(&str, &str)> = checkout["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|step| (step["kind"].as_str().unwrap(), step["object"].as_str().unwrap_or_default()))
        .collect();
    assert_eq!(steps, vec![("call", "/orders/checkout"), ("navigate", "//Main/Orders")]);
}
