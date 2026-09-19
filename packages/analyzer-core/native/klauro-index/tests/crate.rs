mod common;

fn imported(index: &serde_json::Value, source: &str) -> Vec<String> {
    index["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|edge| edge["kind"] == "imports" && edge["source"] == source)
        .map(|edge| edge["target"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn a_path_from_the_crate_root_names_the_module_file_it_reaches() {
    let index = common::read("crate");
    let found = imported(&index, "src/reader/compat/v2_to_v3.rs");
    assert!(found.contains(&"src/reader/mod.rs".to_string()), "{found:?}");
}

#[test]
fn an_item_at_the_crate_root_is_found_in_the_file_that_declares_the_root() {
    let index = common::read("crate");
    let found = imported(&index, "src/reader/compat/v2_to_v3.rs");
    assert!(found.contains(&"src/lib.rs".to_string()), "{found:?}");
}

#[test]
fn a_path_through_the_parent_module_is_read_from_where_the_file_sits() {
    let index = common::read("crate");
    let found = imported(&index, "src/reader/compat/v2_to_v3.rs");
    assert!(
        found.contains(&"src/reader/compat/v1_to_v2.rs".to_string()),
        "super names the module holding this one: {found:?}"
    );
}
