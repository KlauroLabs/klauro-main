mod common;

use std::path::PathBuf;
use std::process::Command;

fn entries(index: &serde_json::Value) -> Vec<&serde_json::Value> {
    index["entry_points"].as_array().unwrap().iter().collect()
}

fn handled_at<'a>(entries: &[&'a serde_json::Value], suffix: &str) -> Option<&'a serde_json::Value> {
    entries.iter().copied().find(|entry| {
        entry["handler"].as_str().is_some_and(|handler| handler.contains(suffix))
    })
}

#[test]
fn a_benchmark_harness_nothing_depends_on_is_an_island() {
    let index = common::read("unshipped_island");
    let all = entries(&index);
    let found = handled_at(&all, "bench/run.js").expect("the harness stays in the entry points");
    assert_eq!(found["unshipped"]["role"], "benchmark");
    assert_eq!(found["unshipped"]["basis"], "island", "{found:#?}");
}

#[test]
fn a_script_that_calls_into_the_product_is_still_an_island_when_nothing_calls_it() {
    let index = common::read("unshipped_island");
    let all = entries(&index);
    let found = handled_at(&all, "scripts/proof.js").expect("the proof script stays in the entry points");
    assert_eq!(found["unshipped"]["role"], "tooling");
    assert_eq!(found["unshipped"]["basis"], "island", "{found:#?}");
}

#[test]
fn an_example_route_stays_an_entry_and_is_tagged() {
    let index = common::read("unshipped_island");
    let all = entries(&index);
    let found = handled_at(&all, "examples/app.py").expect("an example route is kept");
    assert_eq!(found["kind"], "http");
    assert_eq!(found["unshipped"]["role"], "example");
}

#[test]
fn the_shipped_server_and_its_routes_are_not_tagged() {
    let index = common::read("unshipped_island");
    let all = entries(&index);
    let server = handled_at(&all, "server/src/server.js").expect("the bin names this file");
    assert!(server.get("unshipped").is_none(), "{server:#?}");
    let route = handled_at(&all, "server/src/routes.py").expect("a real route");
    assert!(route.get("unshipped").is_none(), "{route:#?}");
}

#[test]
fn a_script_with_only_its_name_to_go_on_is_tagged_by_name() {
    let index = common::read("unshipped_name_only");
    let all = entries(&index);
    let found = handled_at(&all, "scripts/shared.js").expect("a script another file depends on is kept");
    assert_eq!(found["unshipped"]["role"], "tooling");
    assert_eq!(found["unshipped"]["basis"], "name", "{found:#?}");
}

#[test]
fn a_flow_keeps_the_tag_of_its_entry() {
    let index = common::read("unshipped_island");
    let flows = index["comprehension"]["flows"].as_array().expect("flows are in the record");
    let tagged: Vec<&serde_json::Value> = flows.iter().filter(|flow| flow.get("unshipped").is_some()).collect();
    assert!(
        tagged.iter().any(|flow| flow["entry_point"].as_str().is_some_and(|entry| entry.contains("examples/app.py"))),
        "the example route keeps its flow: {tagged:#?}"
    );
    assert!(
        flows.iter().any(|flow| flow["entry_point"].as_str().is_some_and(|entry| entry.contains("server/src/routes.py")) && flow.get("unshipped").is_none()),
        "the real route keeps an untagged flow"
    );
}

#[test]
fn no_product_family_is_proposed_for_a_tagged_flow() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/unshipped_island");
    let output = Command::new(PathBuf::from(env!("CARGO_BIN_EXE_klauro-engine")))
        .arg(&root)
        .env("KLAURO_FAMILY_DUMP", "1")
        .output()
        .expect("index runs");
    let families: Vec<String> = String::from_utf8_lossy(&output.stderr)
        .lines()
        .filter(|line| line.starts_with("family["))
        .map(str::to_string)
        .collect();
    assert!(families.iter().any(|line| line.contains("surface:real")), "the real route is a family: {families:#?}");
    assert!(
        families.iter().all(|line| !line.contains("demo")),
        "the example route is a flow, never a product family: {families:#?}"
    );
}
