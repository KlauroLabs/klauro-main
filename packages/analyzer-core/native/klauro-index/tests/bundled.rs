mod common;

fn index() -> serde_json::Value {
    common::read("bundled")
}

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
fn a_bundler_alias_names_the_file_it_maps_to() {
    let index = index();
    let found = imported(&index, "src/main.ts");
    assert!(found.contains(&"src/lib/utils.ts".to_string()), "{found:?}");
    assert!(found.contains(&"src/ui/panel.ts".to_string()), "{found:?}");
}

#[test]
fn an_alias_onto_an_installed_package_leaves_it_a_dependency() {
    let index = index();
    let found: Vec<&str> = index["dependencies"]["dependencies"]
        .as_array()
        .unwrap()
        .iter()
        .map(|dependency| dependency["name"].as_str().unwrap())
        .collect();
    assert!(
        found.contains(&"react"),
        "an alias onto something the repository does not hold declares nothing: {found:?}"
    );
}

#[test]
fn a_test_runners_module_map_resolves_the_patterns_that_read_as_a_path() {
    let index = index();
    let found = imported(&index, "test/main.spec.ts");
    assert!(
        found.contains(&"test/helpers.ts".to_string()),
        "an anchored prefix with one capture is an alias: {found:?}"
    );
}

#[test]
fn a_pattern_that_maps_a_package_elsewhere_leaves_it_a_dependency() {
    let index = index();
    let found: Vec<&str> = index["dependencies"]["dependencies"]
        .as_array()
        .unwrap()
        .iter()
        .map(|dependency| dependency["name"].as_str().unwrap())
        .collect();
    assert!(found.contains(&"lodash-es"), "{found:?}");
}
