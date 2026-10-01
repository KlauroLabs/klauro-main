mod common;

fn index() -> serde_json::Value {
    common::read("continuation_boundary")
}

fn events(index: &serde_json::Value) -> Vec<&serde_json::Value> {
    index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "event")
        .collect()
}

fn named<'a>(events: &[&'a serde_json::Value], name: &str) -> Option<&'a serde_json::Value> {
    events.iter().copied().find(|entry| entry["name"] == name)
}

#[test]
fn a_callback_on_a_spawned_child_is_not_an_entry() {
    let index = index();
    let events = events(&index);
    assert!(
        named(&events, "exit").is_none(),
        "child.on('exit') continues the spawn this code started: {events:#?}"
    );
}

#[test]
fn a_callback_on_a_spawned_childs_stream_is_not_an_entry() {
    let index = index();
    let events = events(&index);
    assert!(
        named(&events, "data").is_none(),
        "child.stdout.on('data') continues the spawn this code started: {events:#?}"
    );
}

#[test]
fn a_shutdown_signal_on_the_process_stays_an_entry() {
    let index = index();
    let events = events(&index);
    assert!(
        named(&events, "SIGTERM").is_some(),
        "process.on('SIGTERM') is genuine inbound lifecycle shutdown: {events:#?}"
    );
}

#[test]
fn a_servers_own_request_event_stays_an_entry() {
    let index = index();
    let events = events(&index);
    assert!(
        named(&events, "request").is_some(),
        "a server listening for its own inbound requests is not a continuation: {events:#?}"
    );
}

#[test]
fn a_continuations_callback_stays_inside_the_function_that_started_it() {
    let index = index();
    let held = |source: &str, target: &str| {
        index["edges"].as_array().unwrap().iter().any(|edge| {
            edge["kind"] == "contains" && edge["source"] == source && edge["target"] == target
        })
    };
    assert!(held("src/worker-manager.js:function:runTask", "src/worker-manager.js:callback:child.on"));
    assert!(held("src/worker-manager.js:function:runTask", "src/worker-manager.js:callback:child.stdout.on"));
}
