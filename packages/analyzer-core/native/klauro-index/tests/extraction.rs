use std::path::PathBuf;
use std::process::Command;

fn index(fixture: &str) -> serde_json::Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(fixture);
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_klauro-index"));
    let output = Command::new(binary).arg(&root).output().expect("index runs");
    serde_json::from_slice(&output.stdout).expect("index emits json")
}

fn nodes_of(index: &serde_json::Value, kind: &str) -> Vec<serde_json::Value> {
    index["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|node| node["kind"] == kind)
        .cloned()
        .collect()
}

fn named<'a>(index: &'a serde_json::Value, name: &str) -> Option<&'a serde_json::Value> {
    index["nodes"].as_array().unwrap().iter().find(|node| node["name"] == name)
}

fn edges_of(index: &serde_json::Value, kind: &str) -> Vec<(String, String)> {
    index["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|edge| edge["kind"] == kind)
        .map(|edge| {
            (
                edge["source"].as_str().unwrap().to_string(),
                edge["target"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

#[test]
fn every_field_is_parented_to_the_type_that_declares_it() {
    let index = index("typescript");
    let properties = nodes_of(&index, "property");
    assert_eq!(properties.len(), 7, "three interface fields and four class fields");
    let types: std::collections::HashMap<String, String> = index["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|node| {
            (
                node["id"].as_str().unwrap().to_string(),
                node["kind"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    for property in properties {
        let parent = property["parent"].as_str().expect("field has a parent");
        let kind = types.get(parent).expect("parent is in the graph");
        assert!(
            ["class", "interface", "type_alias", "enum"].contains(&kind.as_str()),
            "{} is parented to a {kind}",
            property["name"]
        );
    }
}

#[test]
fn a_type_reaches_its_own_fields_and_methods() {
    let index = index("typescript");
    let manager = named(&index, "CallManager").expect("class is indexed");
    let id = manager["id"].as_str().unwrap();
    let mut fields: Vec<String> = edges_of(&index, "has_field")
        .into_iter()
        .filter(|(source, _)| source == id)
        .map(|(_, target)| target)
        .filter_map(|target| {
            index["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|node| node["id"] == target.as_str())
                .map(|node| node["name"].as_str().unwrap().to_string())
        })
        .collect();
    fields.sort();
    assert_eq!(fields, ["#provider", "active", "instances", "storePath"]);

    let methods = edges_of(&index, "has_method")
        .into_iter()
        .filter(|(source, _)| source == id)
        .count();
    assert_eq!(methods, 3, "constructor, endCall and dispose");
}

#[test]
fn declared_types_and_modifiers_land_on_the_member() {
    let index = index("typescript");
    let store_path = named(&index, "storePath").unwrap();
    assert_eq!(store_path["type_annotation"], "string");
    assert_eq!(store_path["modifiers"]["readonly"], true);

    let instances = named(&index, "instances").unwrap();
    assert_eq!(instances["modifiers"]["is_static"], true);
    assert!(instances["type_annotation"].is_null(), "an unannotated field stays untyped");

    let end_call = named(&index, "endCall").unwrap();
    assert_eq!(end_call["modifiers"]["is_async"], true);
    assert_eq!(end_call["signature"]["return_type"], "Promise<boolean>");
    assert_eq!(end_call["signature"]["parameters"][0]["name"], "id");
    assert_eq!(end_call["signature"]["parameters"][0]["type_annotation"], "string");
}

#[test]
fn heritage_becomes_edges_including_runtime_types() {
    let index = index("typescript");
    let extends = edges_of(&index, "extends");
    let implements = edges_of(&index, "implements");
    assert_eq!(extends.len(), 2, "CallManager extends Base, AppError extends Error");
    assert_eq!(implements.len(), 2, "Base implements Disposable, CallManager implements Session");
    assert!(
        implements.iter().any(|(_, target)| target.starts_with("runtime:Disposable")),
        "a standard library type resolves to the runtime"
    );
    assert!(
        extends.iter().any(|(_, target)| target.starts_with("runtime:Error")),
        "a class extending a runtime global resolves to that global"
    );
}

#[test]
fn a_callback_is_a_function_carrying_its_registration() {
    let index = index("typescript");
    let callbacks: Vec<_> = index["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|node| !node["callback_of"].is_null())
        .collect();
    assert!(!callbacks.is_empty(), "callbacks are indexed as functions");
    let registered = callbacks
        .iter()
        .find(|node| node["registration_label"] == "/health")
        .expect("the route label reaches the handler");
    assert_eq!(registered["callback_of"], "get");
}

#[test]
fn calls_carry_caller_receiver_and_execution_context() {
    let index = index("typescript");
    let calls = index["calls"].as_array().unwrap();
    let close = calls
        .iter()
        .find(|call| call["callee"] == "close")
        .expect("the provider call is recorded");
    assert_eq!(close["receiver"], "this.#provider");
    assert_eq!(close["context"]["in_try"], true);
    assert_eq!(close["context"]["awaited"], true);
    assert_eq!(close["context"]["loop_depth"], 1);
    assert!(close["caller"].as_str().unwrap().contains("endCall"));
}

#[test]
fn a_local_variable_is_not_a_symbol_but_a_local_function_is() {
    let index = index("typescript");
    let variables: Vec<String> = nodes_of(&index, "variable")
        .iter()
        .map(|node| node["name"].as_str().unwrap().to_string())
        .collect();
    assert!(!variables.contains(&"scratch".to_string()), "a function-local const is not a symbol");
    assert!(variables.contains(&"registry".to_string()), "a module-level const is");
}

#[test]
fn imports_resolve_across_files_and_packages() {
    let index = index("typescript");
    let imports = edges_of(&index, "imports");
    assert!(
        imports.iter().any(|(source, target)| source == "app.ts" && target == "manager.ts"),
        "a relative import becomes a file edge"
    );
    let calls = edges_of(&index, "calls");
    assert!(
        calls.iter().any(|(_, target)| target.starts_with("package:node:path:")),
        "a call through an imported package is attributed to that package"
    );
}

#[test]
fn a_grammar_limitation_does_not_cost_the_rest_of_the_file() {
    let index = index("typescript");
    assert!(
        named(&index, "afterTheLimitation").is_some(),
        "declarations after an unparseable type argument are still indexed"
    );
}

#[test]
fn the_same_tree_indexes_identically_twice() {
    let first = index("typescript");
    let second = index("typescript");
    assert_eq!(first, second, "the index is deterministic");
}
