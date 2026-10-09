mod common;

fn steps_of(index: &serde_json::Value, entry: &str) -> Vec<String> {
    index["comprehension"]["flows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|flow| flow["entry_point"].as_str().is_some_and(|held| held.contains(entry)))
        .map(|flow| flow["steps"].as_array().unwrap().iter().filter_map(|step| step["label"].as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

#[test]
fn a_programs_pure_stages_are_its_steps_even_when_handed_to_a_thread() {
    let index = common::read("pipeline_stages");
    let steps = steps_of(&index, "main.rs:function:main");
    assert!(steps.iter().any(|step| step == "Discover discovery"), "{steps:#?}");
    assert!(steps.iter().any(|step| step == "Resolve calls"), "{steps:#?}");
}

#[test]
fn a_bare_verb_stage_is_told_with_its_module() {
    let index = common::read("pipeline_stages");
    let steps = steps_of(&index, "main.rs:function:main");
    assert!(steps.iter().all(|step| step != "Discover"), "a bare verb names no work: {steps:#?}");
}

#[test]
fn a_flow_says_what_it_takes_in_and_what_it_writes_out() {
    let index = common::read("pipeline_stages");
    let flow = index["comprehension"]["flows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|flow| flow["entry_point"].as_str().is_some_and(|entry| entry.contains("main.rs:function:main")))
        .expect("the program is a flow");
    let listed = |field: &str| -> Vec<String> { flow[field].as_array().into_iter().flatten().filter_map(|held| held.as_str().map(str::to_string)).collect() };
    assert!(listed("takes").iter().any(|held| held.contains("read_to_string")), "{flow}");
    assert!(listed("takes").iter().all(|held| !held.starts_with("output:")), "printing is never taking in: {flow}");
    assert!(listed("changes").iter().any(|held| held.starts_with("output:")), "{flow}");
}
