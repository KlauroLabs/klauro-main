mod common;

fn unit<'a>(index: &'a serde_json::Value, root: &str) -> &'a serde_json::Value {
    index["scope"]["deployables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|unit| unit["root"] == root)
        .unwrap_or_else(|| panic!("{root} is a unit"))
}

fn declares(index: &serde_json::Value, root: &str, kind: &str) -> bool {
    unit(index, root)["declarations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|found| found["kind"] == kind && found["declares"] == "ship")
}

fn is_shipped(index: &serde_json::Value, root: &str) -> bool {
    unit(index, root)["category"] == "shipped"
}

fn each_bundler_makes_its_project_a_shipped_deployable(cases: &[(&str, &str)]) {
    let index = common::read("appship");
    for (root, kind) in cases {
        assert!(declares(&index, root, kind), "{root} declares {kind}");
        assert!(is_shipped(&index, root), "{root} is shipped");
    }
}

#[test]
fn a_desktop_bundle_configuration_makes_the_project_shipped() {
    each_bundler_makes_its_project_a_shipped_deployable(&[
        ("tauri/src-tauri", "tauri-bundle"),
        ("electron", "electron-builder"),
        ("electronkey", "electron-builder"),
        ("forge", "electron-forge"),
        ("brief", "briefcase"),
        ("flutter", "flutter-application"),
        ("wpf", "windows-installer"),
        ("jpk", "jpackage"),
    ]);
}

#[test]
fn a_mobile_bundle_configuration_makes_the_project_shipped() {
    each_bundler_makes_its_project_a_shipped_deployable(&[
        ("capacitor", "capacitor"),
        ("cordova", "cordova"),
        ("rn", "expo-build"),
        ("expo", "expo-application"),
    ]);
}

#[test]
fn a_tauri_app_carries_its_frontend_and_the_crates_it_depends_on() {
    let index = common::read("appship");
    let app = unit(&index, "tauri/src-tauri");
    assert_eq!(app["ships"], serde_json::json!(["tauri/app/dist"]));
    let members: Vec<&str> = app["members"].as_array().unwrap().iter().map(|member| member.as_str().unwrap()).collect();
    assert!(members.contains(&"deployable:tauri/app"), "the web app it builds: {members:?}");
    assert!(members.contains(&"deployable:crates/core"), "the crate it links: {members:?}");
}

#[test]
fn a_crate_with_a_main_but_no_bundle_stays_unshipped() {
    let index = common::read("appship");
    assert!(!is_shipped(&index, "rust-crate"));
}

#[test]
fn a_package_without_a_bundler_stays_unshipped() {
    let index = common::read("appship");
    assert!(!is_shipped(&index, "plain-node"));
}

#[test]
fn a_bundle_section_that_is_not_active_stays_unshipped() {
    let index = common::read("appship");
    assert!(!is_shipped(&index, "tauri-inactive"));
}

#[test]
fn a_flutter_app_carries_the_android_runner_it_ships_through() {
    let index = common::read("appship");
    let app = unit(&index, "flutter");
    let members: Vec<&str> = app["members"].as_array().unwrap().iter().map(|member| member.as_str().unwrap()).collect();
    assert!(members.contains(&"deployable:flutter/android/app"), "{members:?}");
}

#[test]
fn a_package_manifest_deep_in_a_project_declares_the_project_not_its_folder() {
    let index = common::read("appship");
    let roots: Vec<&str> = index["scope"]["deployables"]
        .as_array()
        .unwrap()
        .iter()
        .map(|unit| unit["root"].as_str().unwrap())
        .collect();
    assert!(!roots.contains(&"wpf/Platforms/Windows"), "{roots:?}");
}
