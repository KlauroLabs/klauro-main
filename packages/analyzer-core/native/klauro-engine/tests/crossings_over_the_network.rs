mod common;

fn crossings(fixture: &str) -> Vec<(String, String, String)> {
    common::read(fixture)["crossings"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|crossing| crossing["kind"] == "network")
        .map(|crossing| (crossing["channel"].as_str().unwrap().to_string(), crossing["from"].as_str().unwrap().to_string(), crossing["to"].as_str().unwrap().to_string()))
        .collect()
}

#[test]
fn a_message_crosses_only_to_the_case_that_handles_its_tag() {
    let held = crossings("journey-dispatch");
    let saving: Vec<&(String, String, String)> = held.iter().filter(|(_, from, _)| from.ends_with(":saveNote")).collect();
    assert!(!saving.is_empty(), "{held:?}");
    assert!(saving.iter().all(|(channel, _, _)| channel.contains("save")), "{saving:?}");
    assert!(held.iter().any(|(channel, from, to)| channel == "listed" && from.ends_with(":handle") && to.ends_with(":onFrame")), "{held:?}");
    assert!(saving.iter().all(|(channel, _, _)| channel != "list"), "{saving:?}");
}

#[test]
fn a_message_the_client_library_carries_crosses_to_the_handler_behind_the_relay() {
    let held = crossings("journey-relay");
    assert!(held.iter().any(|(_, from, to)| from.ends_with(":sendData") && to.ends_with(":handleDevice")), "{held:?}");
}
