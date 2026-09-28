mod common;

fn index() -> serde_json::Value {
    common::read("symfony")
}

fn entries(index: &serde_json::Value) -> Vec<&serde_json::Value> {
    index["entry_points"].as_array().unwrap().iter().filter(|e| e["kind"] == "http").collect()
}

fn entry_for<'a>(found: &[&'a serde_json::Value], path: &str) -> &'a serde_json::Value {
    found
        .iter()
        .find(|e| e["path"] == path)
        .unwrap_or_else(|| panic!("no route for {path} among {found:?}"))
}

#[test]
fn a_class_attribute_prefixes_the_paths_of_its_methods() {
    let index = index();
    let found = entries(&index);
    let by_path: Vec<&str> = found.iter().map(|e| e["path"].as_str().unwrap_or("")).collect();
    assert!(by_path.contains(&"/blog"), "class prefix /blog is joined onto the method's own /: {by_path:?}");
    assert!(
        by_path.contains(&"/blog/comment/{postSlug}/new"),
        "class prefix /blog is joined onto a method's own longer path: {by_path:?}"
    );
}

#[test]
fn multiple_route_attributes_on_one_method_each_become_their_own_entry() {
    let index = index();
    let found = entries(&index);
    let index_routes: Vec<&&serde_json::Value> = found
        .iter()
        .filter(|e| e["handler"].as_str().unwrap_or("").contains(":index"))
        .collect();
    assert_eq!(index_routes.len(), 2, "index() carries two #[Route] attributes: {found:?}");
    let paths: Vec<&str> = index_routes.iter().map(|e| e["path"].as_str().unwrap_or("")).collect();
    assert!(paths.contains(&"/blog"), "the first #[Route('/')] joins the class prefix: {paths:?}");
    assert!(paths.contains(&"/blog/rss.xml"), "the second #[Route('/rss.xml')] joins the class prefix too: {paths:?}");
}

#[test]
fn a_methods_argument_names_the_http_verb() {
    let index = index();
    let found = entries(&index);
    let comment = entry_for(&found, "/blog/comment/{postSlug}/new");
    assert_eq!(comment["method"], "POST", "methods: ['POST'] names the verb: {comment:?}");
}

#[test]
fn a_route_without_a_methods_argument_serves_any_verb() {
    let index = index();
    let found = entries(&index);
    let legacy = entry_for(&found, "/blog/legacy");
    assert_eq!(legacy["method"], "ANY", "no methods: argument means any verb is accepted: {legacy:?}");
}

#[test]
fn an_invokable_controller_is_served_by_its_invoke_method() {
    let index = index();
    let found = entries(&index);
    let health = entry_for(&found, "/health");
    assert_eq!(health["method"], "GET");
    assert!(
        health["handler"].as_str().unwrap().contains("__invoke"),
        "an __invoke method is the handler for its class's route: {health:?}"
    );
}

#[test]
fn a_bare_class_attribute_with_no_verb_of_its_own_is_not_itself_a_route() {
    let index = index();
    let found = entries(&index);
    assert!(
        !found.iter().any(|e| e["handler"].as_str().unwrap_or("").ends_with(":BlogController")),
        "the class carrying #[Route('/blog')] is a prefix holder, not an endpoint: {found:?}"
    );
}
