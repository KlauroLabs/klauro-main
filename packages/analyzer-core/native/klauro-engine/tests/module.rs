mod common;

use common::calls;

fn index() -> serde_json::Value {
    common::read("module")
}

fn imports(index: &serde_json::Value, source: &str) -> Vec<String> {
    index["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|edge| edge["kind"] == "imports" && edge["source"].as_str().unwrap().ends_with(source))
        .map(|edge| edge["target"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn a_module_path_import_resolves_to_the_file_that_declares_it() {
    let index = index();
    let targets = imports(&index, "app/Services/CreateContact.php");
    assert!(
        targets.iter().any(|target| target == "app/Models/Contact.php"),
        "the namespace names a file in the repository: {targets:?}"
    );
}

#[test]
fn a_package_import_does_not_reach_a_file_written_in_another_language() {
    let index = index();
    let targets = imports(&index, "app/Services/CreateContact.php");
    assert!(
        targets.iter().all(|target| !target.ends_with(".md")),
        "the facade is a package, and prose that shares its path is not the import: {targets:?}"
    );
}

fn dependencies(index: &serde_json::Value) -> Vec<String> {
    index["dependencies"]["dependencies"]
        .as_array()
        .unwrap()
        .iter()
        .map(|dependency| dependency["name"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn a_module_the_repository_declares_is_not_a_dependency() {
    let index = index();
    let found = dependencies(&index);
    assert!(
        found.iter().all(|name| !name.starts_with("App")),
        "the repository's own namespace is not something it depends on: {found:?}"
    );
}

#[test]
fn a_word_between_the_verb_and_the_module_is_not_a_dependency() {
    let index = index();
    let found = dependencies(&index);
    assert!(
        !found.iter().any(|name| name == "function"),
        "an import of a function names the module it comes from: {found:?}"
    );
}
