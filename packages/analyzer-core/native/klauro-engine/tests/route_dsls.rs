mod common;

fn served(fixture: &str) -> Vec<(String, String)> {
    let index = common::read(fixture);
    let mut found: Vec<(String, String)> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "http")
        .map(|entry| {
            (
                entry["method"].as_str().unwrap_or_default().to_string(),
                entry["path"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    found.sort();
    found.dedup();
    found
}

fn pair(method: &str, path: &str) -> (String, String) {
    (method.to_string(), path.to_string())
}

#[test]
fn a_pattern_match_on_a_verb_and_a_root_path_is_a_route() {
    assert_eq!(served("route-dsls/http4s"), vec![pair("DELETE", "/users/:id"), pair("GET", "/users")]);
}

#[test]
fn directives_nested_in_path_directives_are_routes_under_the_joined_path() {
    assert_eq!(
        served("route-dsls/akka"),
        vec![pair("GET", "/api/users"), pair("GET", "/api/users/:param"), pair("POST", "/api/users")]
    );
}

#[test]
fn a_routes_file_in_a_conf_directory_declares_its_routes() {
    assert_eq!(
        served("route-dsls/play"),
        vec![pair("GET", "/users"), pair("GET", "/users/:id"), pair("POST", "/users")]
    );
}

#[test]
fn a_verb_call_chained_into_a_handler_call_is_a_route() {
    assert_eq!(served("route-dsls/vertx"), vec![pair("GET", "/users"), pair("POST", "/users")]);
}

#[test]
fn nested_groups_prefix_their_routes_and_a_controller_string_is_a_handler() {
    assert_eq!(
        served("route-dsls/slim"),
        vec![pair("GET", "/api/items"), pair("GET", "/api/v2/items"), pair("GET", "/users"), pair("POST", "/users")]
    );
}

#[test]
fn a_namespace_block_prefixes_the_routes_it_holds() {
    assert_eq!(served("route-dsls/sinatra"), vec![pair("GET", "/api/health"), pair("GET", "/users")]);
}

#[test]
fn a_router_macro_whose_controller_is_elsewhere_still_serves() {
    assert_eq!(served("route-dsls/phoenix"), vec![pair("GET", "/users"), pair("POST", "/users")]);
}

#[test]
fn an_apex_rest_resource_serves_the_verbs_its_methods_are_annotated_with() {
    assert_eq!(
        served("route-dsls/apex"),
        vec![pair("DELETE", "/users"), pair("GET", "/users"), pair("POST", "/users")]
    );
}
