mod common;

fn index() -> serde_json::Value {
    common::read("one_shot_timer_boundary")
}

fn schedule_entries(index: &serde_json::Value) -> Vec<&serde_json::Value> {
    index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "schedule")
        .collect()
}

#[test]
fn a_one_shot_timer_is_not_an_entry() {
    let index = index();
    let entries = schedule_entries(&index);
    assert!(
        entries.iter().all(|entry| entry["name"] != "onClick"),
        "setTimeout is a continuation of whatever scheduled it, never an entry: {entries:#?}"
    );
}

#[test]
fn a_recurring_timer_stays_an_entry() {
    let index = index();
    let entries = schedule_entries(&index);
    assert!(
        entries.iter().any(|entry| entry["name"] == "scheduleJob"),
        "setInterval is a genuinely recurring schedule entry: {entries:#?}"
    );
}

#[test]
fn a_one_shot_timers_callback_stays_inside_the_function_that_started_it() {
    let index = index();
    assert!(
        index["edges"].as_array().unwrap().iter().any(|edge| {
            edge["kind"] == "contains"
                && edge["source"] == "src/ui.js:function:onClick"
                && edge["target"] == "src/ui.js:callback:setTimeout"
        }),
        "the callback's code stays reachable from the code that scheduled it"
    );
}
