mod common;

use serde_json::Value;

fn drawn(index: &Value) -> Vec<String> {
    let named = |id: &str| -> String {
        index["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["id"] == id)
            .map(|node| node["name"].as_str().unwrap().to_string())
            .unwrap_or_default()
    };
    let mut found: Vec<String> = index["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|edge| edge["kind"] == "renders")
        .map(|edge| format!("{} > {}", named(edge["source"].as_str().unwrap()), named(edge["target"].as_str().unwrap())))
        .collect();
    found.sort();
    found.dedup();
    found
}

#[test]
fn a_component_renders_the_components_its_jsx_names() {
    assert_eq!(drawn(&common::read("render_react-tree")), ["App > UserCard"]);
}

#[test]
fn a_component_wrapped_by_the_framework_is_drawn_from_the_name_that_holds_it() {
    assert_eq!(drawn(&common::read("render_qwik-tree")), ["App > UserCard"]);
}

#[test]
fn a_template_draws_the_components_it_imports() {
    assert_eq!(drawn(&common::read("render_vue-tree")), ["App.vue > UserCard.vue"]);
    assert_eq!(drawn(&common::read("render_svelte-tree")), ["App.svelte > UserCard.svelte"]);
}

#[test]
fn a_template_selector_draws_the_component_that_declares_it() {
    assert_eq!(drawn(&common::read("render_angular-tree")), ["AppComponent > UserCardComponent"]);
}

#[test]
fn a_composable_that_calls_a_composable_renders_it() {
    assert_eq!(
        drawn(&common::read("render_compose-tree")),
        ["App > Footer", "App > Header", "App > UserList", "UserList > UserCard"]
    );
}
