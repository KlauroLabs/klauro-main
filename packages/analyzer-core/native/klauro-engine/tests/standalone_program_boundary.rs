mod common;

fn index() -> serde_json::Value {
    common::read("standalone_program_boundary")
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
fn an_unshipped_standalone_program_is_not_an_entry() {
    let index = index();
    let entries = entries(&index);
    assert!(
        handled_at(&entries, "apps/tool/src/gauntlet-tool.ts").is_none(),
        "a main-guarded program nothing ships is not a product entry point: {entries:#?}"
    );
}

#[test]
fn the_start_scripts_own_target_stays_an_entry() {
    let index = index();
    let entries = entries(&index);
    let found = handled_at(&entries, "apps/tool/src/index.ts")
        .expect("the package's own start script names this exact file");
    assert_eq!(found["kind"], "lifecycle");
}

#[test]
fn a_bin_built_from_this_source_by_convention_stays_an_entry() {
    let index = index();
    let entries = entries(&index);
    let found = handled_at(&entries, "apps/tool/src/cli.ts")
        .expect("dist/cli.cjs is conventionally built from src/cli.ts of the same name");
    assert_eq!(found["kind"], "lifecycle");
}

#[test]
fn a_standalone_program_with_no_shipping_evidence_at_all_keeps_todays_behavior() {
    let index = index();
    let entries = entries(&index);
    let found = handled_at(&entries, "packages/library/src/dev-utility.ts")
        .expect("a part with no shipping evidence at all is not restricted by the new rule");
    assert_eq!(found["kind"], "lifecycle");
}
