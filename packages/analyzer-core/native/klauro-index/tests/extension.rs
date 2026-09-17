mod common;

fn index() -> serde_json::Value {
    common::read("extension")
}

fn id_of(index: &serde_json::Value, name: &str) -> String {
    index["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["name"] == name)
        .unwrap_or_else(|| panic!("{name} is declared"))["id"]
        .as_str()
        .unwrap()
        .to_string()
}

fn calls(index: &serde_json::Value, source: &str, target: &str) -> bool {
    index["edges"].as_array().unwrap().iter().any(|edge| {
        edge["kind"] == "calls"
            && edge["source"].as_str().unwrap().ends_with(source)
            && edge["target"].as_str().unwrap().ends_with(target)
    })
}

#[test]
fn an_extension_function_records_the_type_it_extends() {
    let index = index();
    let declared = index["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["name"] == "orPlaceholder")
        .expect("the extension is declared");
    assert_eq!(declared["signature"]["receiver"], "ShowDao");
}

#[test]
fn a_constructor_parameter_types_the_receivers_in_the_class_body() {
    let index = index();
    assert!(
        calls(&index, "function:load:6", "function:orPlaceholder:7"),
        "showDao is typed by the primary constructor, so the extension call resolves"
    );
}

#[test]
fn an_imported_name_is_not_claimed_by_a_unique_extension() {
    let index = index();
    let ours = id_of(&index, "collectAsState");
    assert!(
        !calls(&index, "function:render:5", &ours),
        "screen.kt imports collectAsState from a package, so the call is not ours"
    );
}

#[test]
fn a_unique_extension_still_resolves_without_a_competing_import() {
    let index = index();
    assert!(
        calls(&index, "function:widget:3", "function:collectAsState:3"),
        "nothing else declares or imports collectAsState here"
    );
}

#[test]
fn a_holder_is_unwrapped_to_reach_an_inherited_member() {
    let index = index();
    assert!(
        calls(&index, "function:open:16", "function:start:8"),
        "Lazy<Job> unwraps to Job, which inherits start from BaseJob"
    );
}
