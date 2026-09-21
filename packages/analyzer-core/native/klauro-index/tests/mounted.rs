mod common;

fn routes(index: &serde_json::Value) -> Vec<(String, String, String)> {
    index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "http")
        .map(|entry| {
            (
                entry["method"].as_str().unwrap_or("ANY").to_string(),
                entry["path"].as_str().unwrap_or_default().to_string(),
                entry["handler"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

#[test]
fn a_resource_mounted_at_a_path_serves_the_handler_its_chain_hands_over() {
    let index = common::read("mounted");
    let found = routes(&index);
    assert!(
        found.iter().any(|(method, path, handler)| method == "GET"
            && path == "/tasks"
            && common::names(handler, "function:list_tasks:3")),
        "{found:?}"
    );
    assert!(
        found.iter().any(|(method, path, handler)| method == "POST"
            && path == "/dumps"
            && common::names(handler, "function:create_dump:7")),
        "{found:?}"
    );
}

#[test]
fn a_route_reads_its_method_from_the_call_that_names_it() {
    let index = common::read("mounted");
    let found = routes(&index);
    assert!(
        found.iter().any(|(method, path, _)| method == "GET" && path == "/health"),
        "the method sits beside the handler rather than on the registrar: {found:?}"
    );
}
