mod common;

fn dependencies(index: &serde_json::Value) -> Vec<String> {
    index["dependencies"]["dependencies"]
        .as_array()
        .unwrap()
        .iter()
        .map(|dependency| dependency["name"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn a_module_declares_the_path_its_own_packages_are_imported_by() {
    let index = common::read("gomodule");
    let found = dependencies(&index);
    assert!(
        !found.iter().any(|name| name.starts_with("example.com/tool")),
        "the module path names this repository, not something it depends on: {found:?}"
    );
}

#[test]
fn a_package_from_another_module_is_still_a_dependency() {
    let index = common::read("gomodule");
    let found = dependencies(&index);
    assert!(found.contains(&"github.com/spf13/cobra".to_string()), "{found:?}");
}

#[test]
fn the_languages_own_library_is_a_runtime_rather_than_a_dependency() {
    let index = common::read("gomodule");
    let roles: Vec<(&str, &str)> = index["dependencies"]["dependencies"]
        .as_array()
        .unwrap()
        .iter()
        .map(|dependency| {
            (
                dependency["name"].as_str().unwrap(),
                dependency["role"].as_str().unwrap(),
            )
        })
        .collect();
    assert!(roles.contains(&("fmt", "runtime")), "{roles:?}");
}
