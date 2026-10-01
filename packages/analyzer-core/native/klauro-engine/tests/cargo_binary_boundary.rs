mod common;

fn index() -> serde_json::Value {
    common::read("cargo_binary_boundary")
}

fn entries(index: &serde_json::Value) -> Vec<&serde_json::Value> {
    index["entry_points"].as_array().unwrap().iter().collect()
}

fn handled_at<'a>(entries: &[&'a serde_json::Value], suffix: &str) -> Option<&'a serde_json::Value> {
    entries.iter().copied().find(|entry| {
        entry["handler"].as_str().is_some_and(|handler| handler.contains(suffix))
    })
}

#[test]
fn a_cargo_build_script_is_never_an_entry() {
    let index = index();
    let entries = entries(&index);
    assert!(
        handled_at(&entries, "build.rs").is_none(),
        "a Cargo build script's main() runs the build, not the product: {entries:#?}"
    );
}

#[test]
fn the_crates_own_main_stays_an_entry() {
    let index = index();
    let entries = entries(&index);
    let found = handled_at(&entries, "src/main.rs").expect("src/main.rs is the crate's default binary");
    assert_eq!(found["kind"], "lifecycle");
}

#[test]
fn a_src_bin_file_stays_an_entry() {
    let index = index();
    let entries = entries(&index);
    let found = handled_at(&entries, "src/bin/extra_tool.rs").expect("src/bin/*.rs is a real Cargo binary target");
    assert_eq!(found["kind"], "lifecycle");
}

#[test]
fn a_build_rs_with_no_manifest_beside_it_is_kept_and_tagged_as_tooling() {
    let index = common::read("cargo_build_script_without_manifest");
    let entries: Vec<&serde_json::Value> = index["entry_points"].as_array().unwrap().iter().collect();
    let found = handled_at(&entries, "build.rs").expect("nothing declares it a build script, so it is kept");
    assert_eq!(found["unshipped"]["role"], "tooling", "{found:#?}");
}
