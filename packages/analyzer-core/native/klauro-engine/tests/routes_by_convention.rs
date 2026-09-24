mod common;

fn served(fixture: &str) -> Vec<(String, String, String)> {
    let index = common::read(fixture);
    let mut held: Vec<(String, String, String)> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "http")
        .map(|entry| {
            let handler = entry["handler"].as_str().unwrap();
            let named: Vec<&str> = handler.split(':').collect();
            (
                entry["method"].as_str().unwrap_or("-").to_string(),
                entry["path"].as_str().unwrap_or("-").to_string(),
                format!("{}#{}", named[0].rsplit('/').next().unwrap(), named.get(named.len().saturating_sub(3)).unwrap_or(&"")),
            )
        })
        .collect();
    held.sort();
    held
}

#[test]
fn a_rails_route_enters_the_action_its_resources_and_namespaces_name() {
    let held = served("rails");
    for wanted in [
        ("GET", "/", "home_controller.rb#index"),
        ("GET", "/api/v1/statuses/:id", "statuses_controller.rb#show"),
        ("DELETE", "/api/v1/statuses/:id", "statuses_controller.rb#destroy"),
        ("POST", "/api/v1/statuses/:status_id/favourite", "favourites_controller.rb#create"),
        ("POST", "/api/v1/statuses/:status_id/unfavourite", "favourites_controller.rb#destroy"),
    ] {
        assert!(
            held.iter().any(|(method, path, handler)| method == wanted.0 && path == wanted.1 && handler == wanted.2),
            "{wanted:?} in {held:?}"
        );
    }
    assert!(!held.iter().any(|(_, _, handler)| handler.starts_with("routes.rb")), "{held:?}");
}

#[test]
fn a_laravel_route_enters_the_method_its_array_names() {
    let held = served("laravel-routes");
    assert!(held.contains(&("POST".into(), "/calls".into(), "CallController.php#store".into())), "{held:?}");
    assert!(held.contains(&("DELETE".into(), "/calls/{call}".into(), "CallController.php#destroy".into())), "{held:?}");
}

#[test]
fn a_jax_rs_resource_joins_its_class_path_and_its_method_path() {
    let held = served("surfaces");
    assert!(held.contains(&("GET".into(), "/items/{id}".into(), "ItemResource.java#item".into())), "{held:?}");
}

#[test]
fn a_flow_runs_the_callbacks_before_its_action_and_names_what_it_does_to_the_record() {
    let index = common::read("rails");
    let flows = index["comprehension"]["flows"].as_array().unwrap();
    let removing = flows
        .iter()
        .find(|flow| flow["method"] == "DELETE" && flow["operation"] == "/api/v1/statuses/:id")
        .unwrap();
    let labels: Vec<&str> = removing["steps"].as_array().unwrap().iter().filter_map(|step| step["label"].as_str()).collect();
    assert_eq!(labels.first().copied(), Some("Read Status"), "{labels:?}");
    assert!(labels.contains(&"Remove Status"), "{labels:?}");
    let favouring = flows
        .iter()
        .find(|flow| flow["method"] == "POST" && flow["operation"] == "/api/v1/statuses/:status_id/favourite")
        .unwrap();
    assert!(favouring["writes"].as_array().unwrap().iter().any(|held| held == "Favourite"), "{favouring}");
}
