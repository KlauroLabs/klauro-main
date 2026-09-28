mod common;

fn index() -> serde_json::Value {
    common::read("bundler_build_evidence")
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
fn a_bundler_entry_whose_output_is_the_published_bin_stays_an_entry() {
    let index = index();
    let entries = entries(&index);
    let found = handled_at(&entries, "src/cli.ts")
        .expect("the build() call names this file's output as the package's bin");
    assert_eq!(found["kind"], "lifecycle");
}

#[test]
fn a_bundler_entry_whose_output_nothing_ships_is_not_an_entry() {
    let index = index();
    let entries = entries(&index);
    assert!(
        handled_at(&entries, "src/other-tool.ts").is_none(),
        "dist/other-tool.cjs is built but never named by any shipping evidence: {entries:#?}"
    );
}
