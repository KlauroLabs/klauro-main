mod common;

fn walks(index: &serde_json::Value) -> Vec<Vec<String>> {
    index["journeys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|journey| journey["steps"].as_array().unwrap().iter().map(|step| step["symbol"].as_str().unwrap().to_string()).collect())
        .collect()
}

#[test]
fn a_message_follows_only_the_case_that_handles_its_tag() {
    let index = common::read("journey-dispatch");
    let walks = walks(&index);
    let saving: Vec<&Vec<String>> = walks.iter().filter(|walk| walk.first().is_some_and(|first| first == "saveNote")).collect();
    assert!(!saving.is_empty(), "{walks:?}");
    for walk in &saving {
        assert!(!walk.iter().any(|symbol| symbol == "onFrame"), "saving a note must not follow the list or default arms: {walk:?}");
    }
    let effects: Vec<&str> = index["journeys"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|journey| journey["steps"][0]["symbol"] == "saveNote")
        .filter_map(|journey| journey["steps"].as_array().unwrap().last()?["effect"].as_str())
        .collect();
    assert!(effects.iter().any(|effect| effect.starts_with("file")), "{effects:?}");
}

#[test]
fn the_other_arm_still_reaches_its_own_reply() {
    let index = common::read("journey-dispatch");
    let walks = walks(&index);
    assert!(
        walks.iter().any(|walk| walk.first().is_some_and(|first| first == "listNotes") && walk.iter().any(|symbol| symbol == "onFrame")),
        "{walks:?}"
    );
}
