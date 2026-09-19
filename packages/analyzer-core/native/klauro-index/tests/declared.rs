mod common;

fn dependencies(index: &serde_json::Value) -> Vec<(&str, bool, u64, Option<&str>)> {
    index["dependencies"]["dependencies"]
        .as_array()
        .unwrap()
        .iter()
        .map(|dependency| {
            (
                dependency["name"].as_str().unwrap(),
                dependency["declared"].as_bool().unwrap_or(false),
                dependency["imports"].as_u64().unwrap_or(0),
                dependency["version"].as_str(),
            )
        })
        .collect()
}

#[test]
fn a_manifest_declares_dependencies_the_code_never_imports() {
    let index = common::read("declared");
    let found = dependencies(&index);
    assert!(
        found.contains(&("marked", true, 0, Some("12.0.0"))),
        "a dependency is present because the manifest says so: {found:?}"
    );
    assert!(found.iter().any(|(name, ..)| *name == "vitest"), "{found:?}");
}

#[test]
fn a_dependency_both_declared_and_imported_carries_both() {
    let index = common::read("declared");
    let found = dependencies(&index);
    let express = found.iter().find(|(name, ..)| *name == "express").expect("express");
    assert!(express.1, "declared by the manifest: {express:?}");
    assert!(express.2 > 0, "imported by the code: {express:?}");
}

#[test]
fn a_requirement_is_read_without_the_version_it_is_pinned_to() {
    let index = common::read("declared");
    let found = dependencies(&index);
    assert!(found.iter().any(|(name, ..)| *name == "django"), "{found:?}");
    assert!(found.iter().any(|(name, ..)| *name == "graphene"), "{found:?}");
}

#[test]
fn a_package_a_project_file_references_is_a_dependency() {
    let index = common::read("declared");
    let found = dependencies(&index);
    assert!(found.iter().any(|(name, ..)| *name == "Serilog"), "{found:?}");
}
