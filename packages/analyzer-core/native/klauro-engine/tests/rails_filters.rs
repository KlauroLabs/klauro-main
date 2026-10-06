mod common;

fn served() -> Vec<(String, Vec<String>)> {
    let index = common::read("rails_filters");
    let mut found: Vec<(String, Vec<String>)> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "http")
        .map(|entry| {
            let mut guards: Vec<String> =
                entry["guards"].as_array().into_iter().flatten().map(|guard| guard["name"].as_str().unwrap().to_string()).collect();
            guards.sort();
            (format!("{} {}", entry["method"].as_str().unwrap_or_default(), entry["path"].as_str().unwrap()), guards)
        })
        .collect();
    found.sort();
    found
}

fn guards_of(found: &[(String, Vec<String>)], route: &str) -> Vec<String> {
    found.iter().find(|(held, _)| held == route).unwrap_or_else(|| panic!("{route} is served: {found:?}")).1.clone()
}

#[test]
fn a_namespace_prefixes_its_routes_and_leaves_no_route_with_the_namespace_as_a_segment() {
    let found = served();
    assert!(found.iter().any(|(route, _)| route == "GET /admin/dashboard"), "{found:?}");
    assert!(!found.iter().any(|(route, _)| route.contains(":admin")), "{found:?}");
    assert_eq!(found.iter().filter(|(route, _)| route.ends_with("/dashboard")).count(), 1, "{found:?}");
}

#[test]
fn a_redirect_and_a_with_options_route_are_each_served_once_at_their_scoped_path() {
    let found = served();
    assert_eq!(found.iter().filter(|(route, _)| route == "GET /old").count(), 1, "{found:?}");
    assert_eq!(found.iter().filter(|(route, _)| route == "GET /about").count(), 1, "{found:?}");
}

#[test]
fn a_callback_that_ends_the_request_on_failure_is_a_guard() {
    assert_eq!(guards_of(&served(), "GET /secret"), vec!["require_authenticated_user!"]);
}

#[test]
fn a_framework_authentication_callback_is_a_guard() {
    assert_eq!(guards_of(&served(), "GET /posts"), vec!["authenticate_user!"]);
}

#[test]
fn a_record_loader_and_a_cache_control_callback_are_no_guards() {
    let found = served();
    assert!(guards_of(&found, "GET /posts/:id").is_empty(), "{found:?}");
    assert!(!guards_of(&found, "GET /posts").iter().any(|name| name == "set_policy" || name == "cache_even_if_authenticated!"));
}
