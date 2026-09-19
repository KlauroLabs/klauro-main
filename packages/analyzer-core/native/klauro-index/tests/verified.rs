mod common;

fn index() -> serde_json::Value {
    common::read("verified")
}

fn gaps(index: &serde_json::Value) -> Vec<(String, String)> {
    index["verification"]["gaps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|gap| {
            (
                gap["gap"].as_str().unwrap().to_string(),
                gap["node"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

#[test]
fn a_case_carries_what_it_checks_and_what_it_stands_in_for() {
    let index = index();
    let cases = index["verification"]["cases"].as_array().unwrap();
    let checked = cases
        .iter()
        .find(|case| case["name"].as_str().unwrap().contains("slug_is_lowered"))
        .expect("the case is a test");
    assert!(checked["assertions"].as_u64().unwrap() > 0, "{checked}");
    let standing = cases
        .iter()
        .find(|case| case["name"].as_str().unwrap().contains("stand_in"))
        .expect("the case is a test");
    assert!(
        !standing["stands_in_for"].as_array().unwrap().is_empty(),
        "the case patches what it does not run: {standing}"
    );
}

#[test]
fn a_test_that_calls_a_unit_covers_it() {
    let index = index();
    let coverage = &index["verification"]["coverage"];
    assert!(coverage["served_and_tested"].as_u64().unwrap() > 0, "{coverage}");
}

#[test]
fn a_test_that_asks_for_a_route_covers_the_surface_it_serves() {
    let index = index();
    let coverage = &index["verification"]["coverage"];
    assert_eq!(coverage["requested_routes"], 1, "{coverage}");
    assert_eq!(coverage["entry_points_tested"], 1, "{coverage}");
}

#[test]
fn a_reported_coverage_run_is_read_and_matched_to_the_files_it_names() {
    let index = index();
    let reported = &index["verification"]["coverage"]["reported"];
    assert_eq!(reported["files"], 1, "{reported}");
    assert_eq!(reported["matched"], 1, "{reported}");
    assert_eq!(reported["lines"], 3, "{reported}");
    assert_eq!(reported["hit"], 2, "{reported}");
}

#[test]
fn what_no_test_reaches_and_what_no_case_checks_are_gaps() {
    let index = index();
    let found = gaps(&index);
    assert!(
        found.iter().any(|(gap, node)| gap == "untested-surface" && node.contains("health")),
        "{found:?}"
    );
    assert!(
        found.iter().any(|(gap, node)| gap == "no-assertions" && node.contains("nothing_is_checked")),
        "{found:?}"
    );
    assert!(
        found.iter().any(|(gap, node)| gap == "stands-in-only" && node.contains("stand_in")),
        "{found:?}"
    );
}

#[test]
fn a_guard_on_one_surface_names_the_sibling_that_lacks_it() {
    let index = index();
    let invariants = index["verification"]["invariants"].as_array().unwrap();
    let guarded = invariants
        .iter()
        .find(|invariant| invariant["guard"] == "login_required")
        .expect("the guard is declared");
    assert!(
        guarded["holds"]
            .as_array()
            .unwrap()
            .iter()
            .any(|held| held.as_str().unwrap().contains("list_stores")),
        "{guarded}"
    );
    assert!(
        guarded["missing"]
            .as_array()
            .unwrap()
            .iter()
            .any(|held| held.as_str().unwrap().contains("admin_health")),
        "a surface beside a guarded one without the guard: {guarded}"
    );
    assert!(
        gaps(&index)
            .iter()
            .any(|(gap, node)| gap == "unguarded-surface" && node.contains("admin_health")),
        "the gap is reported beside the invariant"
    );
}
