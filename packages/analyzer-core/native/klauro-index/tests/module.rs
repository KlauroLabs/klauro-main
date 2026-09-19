mod common;

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
