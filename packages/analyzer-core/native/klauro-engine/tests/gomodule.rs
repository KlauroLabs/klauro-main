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
fn an_import_of_a_package_reaches_every_file_the_package_is_written_across() {
    let index = common::read("gomodule");
    let found = imported(&index, "cmd/main.go");
    assert!(found.contains(&"internal/store/store.go".to_string()), "{found:?}");
    assert!(found.contains(&"internal/store/keys.go".to_string()), "{found:?}");
}

#[test]
fn a_packages_own_tests_are_not_what_an_importer_reaches() {
    let index = common::read("gomodule");
    let found = imported(&index, "cmd/main.go");
    assert!(
        !found.iter().any(|target| target.ends_with("_test.go")),
        "a test of a package is not part of what it exports: {found:?}"
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
