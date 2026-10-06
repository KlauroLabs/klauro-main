mod common;

#[test]
fn locals_that_stand_for_each_other_resolve_without_looping() {
    let index = common::read("mutual_locals");
    let files = index["files"].as_array().unwrap();
    assert_eq!(files.iter().filter(|file| file["path"].as_str().is_some_and(|path| path.ends_with(".ts"))).count(), 2);
}

#[test]
fn a_chain_of_locals_that_does_end_still_resolves_to_its_method() {
    let index = common::read("mutual_locals");
    let reached: Vec<&str> = index["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|edge| edge["kind"] == "calls" && edge["source"].as_str().is_some_and(|source| common::names(source, "reach")))
        .filter_map(|edge| edge["target"].as_str())
        .collect();
    assert!(reached.iter().any(|target| *target == "visitor.ts:method:visit"), "{reached:?}");
}
