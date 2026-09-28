mod common;

fn export_entries(index: &serde_json::Value) -> Vec<String> {
    index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "export")
        .map(|entry| entry["name"].as_str().unwrap_or_default().to_string())
        .collect()
}

#[test]
fn a_private_workspace_package_offers_nothing_to_the_outside() {
    let index = common::read("exports_private_lib");
    let found = export_entries(&index);
    assert!(found.is_empty(), "a private:true package must not surface exports: {found:?}");
}

#[test]
fn a_single_page_apps_components_are_not_a_published_api() {
    let index = common::read("exports_spa");
    let found = export_entries(&index);
    assert!(
        found.is_empty(),
        "a vite app's components are UI, not a published surface: {found:?}"
    );
}

#[test]
fn a_publishable_npm_library_keeps_its_export_surface() {
    let index = common::read("exports_public_lib");
    let found = export_entries(&index);
    assert!(
        found.contains(&"formatCurrency".to_string()),
        "a named, non-private package with a main/types entry is a real published library: {found:?}"
    );
}

#[test]
fn a_rust_crate_marked_publish_false_and_used_only_in_repo_offers_nothing() {
    let index = common::read("exports_internal_crate");
    let found = export_entries(&index);
    assert!(found.is_empty(), "publish = false means the crate is not a published surface: {found:?}");
}
