mod common;

fn index() -> serde_json::Value {
    common::read("benchmark_naming_boundary")
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
fn a_benchmark_named_file_with_no_shipping_evidence_stays_an_entry_tagged_as_a_benchmark() {
    let index = index();
    let entries = entries(&index);
    let found = handled_at(&entries, "src/agent-benchmark.ts")
        .expect("a file whose name is a benchmark is kept, and only marked");
    assert_eq!(found["unshipped"]["role"], "benchmark", "{found:#?}");
}

#[test]
fn a_benchmark_named_file_a_manifest_ships_stays_an_entry() {
    let index = index();
    let entries = entries(&index);
    let found = handled_at(&entries, "tool-benchmark.js")
        .expect("package.json's bin names this file, so it still ships despite its name");
    assert_eq!(found["kind"], "lifecycle");
}

#[test]
fn a_plainly_named_real_entry_still_serves() {
    let index = index();
    let entries = entries(&index);
    let found = handled_at(&entries, "src/real-server.ts").expect("a real entry point stays one");
    assert_eq!(found["kind"], "lifecycle");
}
