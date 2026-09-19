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
fn a_config_inherits_the_mappings_of_the_one_it_extends() {
    let index = common::read("extended");
    let found = imported(&index, "apps/web/src/main.ts");
    assert!(
        found.contains(&"config/src/lib/format.ts".to_string()),
        "the mapping is declared by a config in another package: {found:?}"
    );
}

#[test]
fn an_inherited_mapping_resolves_against_the_config_that_declares_it() {
    let index = common::read("extended");
    let found = imported(&index, "apps/web/src/main.ts");
    assert!(
        !found.iter().any(|target| target.starts_with("apps/web/src/lib")),
        "an inherited target belongs to the config it came from: {found:?}"
    );
    assert!(found.contains(&"apps/web/src/ui/panel.ts".to_string()), "{found:?}");
}
