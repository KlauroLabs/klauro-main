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
    let properties: Vec<serde_json::Value> = nodes_of(&index, "property")
        .into_iter()
        .filter(|node| node["id"].as_str().unwrap().starts_with("manager.ts"))
        .collect();
    assert_eq!(properties.len(), 8, "three interface fields and five class fields");
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
    assert_eq!(fields, ["#provider", "active", "instances", "store", "storePath"]);

    let methods = edges_of(&index, "has_method")
        .into_iter()
        .filter(|(source, _)| source == id)
        .count();
    assert_eq!(methods, 4, "constructor, endCall, save and dispose");
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
    assert_eq!(registered["callback_of"], "server.get");
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

#[test]
fn a_route_registration_is_an_http_entry_point_attached_to_its_handler() {
    let index = index("typescript");
    let entries = index["entry_points"].as_array().unwrap();
    let health = entries
        .iter()
        .find(|entry| entry["path"] == "/health")
        .expect("the route is an entry point");
    assert_eq!(health["kind"], "http");
    assert_eq!(health["method"], "GET");
    assert_eq!(health["registrar"], "server.get");
    let handler = health["handler"].as_str().unwrap();
    assert!(
        index["nodes"].as_array().unwrap().iter().any(|node| node["id"] == handler),
        "the handler is a node in the graph"
    );

    let created = entries
        .iter()
        .find(|entry| entry["path"] == "/calls/:id")
        .expect("a parameterised path is a path");
    assert_eq!(created["method"], "POST");
}

#[test]
fn only_calls_that_leave_the_process_are_exit_points() {
    let index = index("typescript");
    let exits = index["exit_points"].as_array().unwrap();
    let kinds: Vec<&str> = exits.iter().map(|exit| exit["kind"].as_str().unwrap()).collect();
    assert!(kinds.contains(&"file"), "the filesystem write is an exit");
    assert!(kinds.contains(&"api"), "the network call is an exit");

    let file = exits.iter().find(|exit| exit["kind"] == "file").unwrap();
    assert_eq!(file["target"], "node:fs/promises");
    assert!(file["source"].as_str().unwrap().contains("persist"));

    assert!(
        !exits.iter().any(|exit| exit["operation"] == "join"),
        "a pure path computation does not leave the process"
    );
}

#[test]
fn icelot_states_what_a_unit_takes_guards_does_and_returns() {
    let index = index("typescript");
    let persist = index["icelot"]
        .as_array()
        .unwrap()
        .iter()
        .find(|unit| unit["unit"].as_str().unwrap().contains("persist"))
        .expect("the unit has icelot");

    assert_eq!(persist["input"]["parameters"], 1);
    assert_eq!(persist["input"]["types"][0], "string");
    assert_eq!(persist["constraints"]["throws"][0], "ValidationError");
    assert_eq!(persist["constraints"]["guards"], 1);
    assert_eq!(persist["logic"]["awaits"], 2);
    assert_eq!(persist["output"]["return_type"], "Promise<void>");
    assert_eq!(persist["effects"]["exits"].as_array().unwrap().len(), 2);
}

#[test]
fn a_logging_call_is_telemetry_and_a_path_call_is_not() {
    let index = index("typescript");
    let handler = index["icelot"]
        .as_array()
        .unwrap()
        .iter()
        .find(|unit| {
            !unit["telemetry"].as_array().map(|sites| sites.is_empty()).unwrap_or(true)
        })
        .expect("a unit carries telemetry");
    let sites = handler["telemetry"].as_array().unwrap();
    assert_eq!(sites[0]["kind"], "log");
    assert_eq!(sites[0]["callee"], "logger.info");
}

#[test]
fn an_entry_point_reaches_the_units_it_runs() {
    let index = index("typescript");
    let entries = index["entry_points"].as_array().unwrap();
    let created = entries.iter().find(|entry| entry["path"] == "/calls/:id").unwrap();
    let reach = index["graph"]["entry_reach"]
        .as_array()
        .unwrap()
        .iter()
        .find(|reach| reach["entry_point"] == created["id"])
        .expect("the entry point has reach");
    assert!(reach["units"].as_u64().unwrap() >= 1, "it reaches the handler it calls");
    assert!(reach["exits"].as_u64().unwrap() >= 2, "and the exits underneath it");
}

#[test]
fn structural_importance_counts_the_entry_points_above_a_unit() {
    let index = index("typescript");
    let persist = index["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["name"] == "persist")
        .unwrap();
    let reach = index["graph"]["reach"]
        .as_array()
        .unwrap()
        .iter()
        .find(|reach| reach["node"] == persist["id"])
        .expect("a called unit is in the reach table");
    assert!(reach["fan_in"].as_u64().unwrap() >= 1);
    assert!(reach["entry_points"].as_u64().unwrap() >= 1);
    assert!(reach["depth"].as_u64().is_some(), "it is reachable from an entry point");
}

#[test]
fn a_call_through_a_typed_field_resolves_to_that_types_method() {
    let index = index("typescript");
    let save = named(&index, "save").expect("the caller is indexed");
    let write = index["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["name"] == "write")
        .expect("the callee is indexed");
    let calls = edges_of(&index, "calls");
    assert!(
        calls
            .iter()
            .any(|(source, target)| source == save["id"].as_str().unwrap()
                && target == write["id"].as_str().unwrap()),
        "this.store.write reaches Store.write, not a method named write on CallManager"
    );
}

#[test]
fn a_call_through_a_typed_parameter_resolves_to_that_types_method() {
    let index = index("typescript");
    let run = named(&index, "run").expect("the caller is indexed");
    let write = index["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["name"] == "write")
        .unwrap();
    let calls = edges_of(&index, "calls");
    assert!(
        calls
            .iter()
            .any(|(source, target)| source == run["id"].as_str().unwrap()
                && target == write["id"].as_str().unwrap()),
        "a parameter's declared type resolves the call made through it"
    );
}
