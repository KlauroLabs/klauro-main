mod common;

fn targets(index: &serde_json::Value, source: &str) -> Vec<String> {
    index["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|edge| edge["kind"] == "imports" && edge["source"] == source)
        .map(|edge| edge["target"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn a_declared_alias_names_the_file_it_maps_to() {
    let index = common::read("alias");
    let found = targets(&index, "src/app/page.ts");
    assert!(found.contains(&"src/lib/settings.ts".to_string()), "{found:?}");
    assert!(found.contains(&"src/app/render.ts".to_string()), "{found:?}");
}

#[test]
fn a_framework_alias_names_the_directory_the_framework_gives_it() {
    let index = common::read("alias");
    let found = targets(&index, "src/app/page.ts");
    assert!(found.contains(&"src/lib/format.ts".to_string()), "{found:?}");
}

#[test]
fn an_alias_is_not_a_dependency_and_a_package_still_is() {
    let index = common::read("alias");
    let found: Vec<&str> = index["dependencies"]["dependencies"]
        .as_array()
        .unwrap()
        .iter()
        .map(|dependency| dependency["name"].as_str().unwrap())
        .collect();
    assert_eq!(found, ["marked"], "only what the repository does not hold is a dependency");
}
