mod common;

fn index() -> serde_json::Value {
    common::read("mapped")
}

#[test]
fn a_module_map_a_package_manifest_declares_resolves_an_import() {
    let index = index();
    let found: Vec<&str> = index["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|edge| edge["kind"] == "imports" && edge["source"] == "src/app/page.spec.ts")
        .map(|edge| edge["target"].as_str().unwrap())
        .collect();
    assert_eq!(found, ["src/support/render.ts"], "{found:?}");
}

#[test]
fn a_manifest_mapping_onto_an_installed_package_leaves_it_a_dependency() {
    let index = index();
    let found: Vec<&str> = index["dependencies"]["dependencies"]
        .as_array()
        .unwrap()
        .iter()
        .map(|dependency| dependency["name"].as_str().unwrap())
        .collect();
    assert_eq!(found, ["lodash-es"], "{found:?}");
}
