mod common;

fn entries(fixture: &str) -> Vec<(String, String, Option<String>, Option<String>)> {
    let index = common::read(fixture);
    index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["kind"].as_str().unwrap().to_string(),
                entry["name"].as_str().unwrap_or_default().to_string(),
                entry["method"].as_str().map(|held| held.to_string()),
                entry["path"].as_str().map(|held| held.to_string()),
            )
        })
        .collect()
}

#[test]
fn a_hand_rolled_node_router_enters_every_method_and_path_branch() {
    let held = entries("dispatch-node");
    let http: Vec<&(String, String, Option<String>, Option<String>)> =
        held.iter().filter(|(kind, ..)| kind == "http").collect();
    for (method, path) in [
        ("GET", "/health"),
        ("POST", "/api/auth/login"),
        ("GET", "/dist/*"),
    ] {
        assert!(
            http.iter().any(|(_, _, found_method, found_path)| {
                found_method.as_deref() == Some(method) && found_path.as_deref() == Some(path)
            }),
            "expected {method} {path} in {http:?}"
        );
    }
}

#[test]
fn a_nested_sub_handler_still_enters_its_own_method_and_path_branches() {
    let held = entries("dispatch-node");
    let http: Vec<&(String, String, Option<String>, Option<String>)> =
        held.iter().filter(|(kind, ..)| kind == "http").collect();
    for (method, path) in [("GET", "/api/me"), ("POST", "/api/auth/change-password")] {
        assert!(
            http.iter().any(|(_, _, found_method, found_path)| {
                found_method.as_deref() == Some(method) && found_path.as_deref() == Some(path)
            }),
            "expected {method} {path} (from the nested handler) in {http:?}"
        );
    }
}

#[test]
fn a_single_tauri_command_dispatching_on_its_channel_enters_every_channel() {
    let held = entries("dispatch-tauri");
    let ipc: Vec<&(String, String, Option<String>, Option<String>)> =
        held.iter().filter(|(kind, ..)| kind == "ipc").collect();
    for channel in ["archive:resolve", "klauro-analysis:start", "klauro-analysis:state"] {
        assert!(ipc.iter().any(|(_, name, ..)| name == channel), "expected {channel} in {ipc:?}");
    }
}

#[test]
fn a_match_arm_named_by_a_constant_resolves_through_the_constant_to_its_channel_string() {
    let held = entries("dispatch-tauri");
    let ipc: Vec<&(String, String, Option<String>, Option<String>)> =
        held.iter().filter(|(kind, ..)| kind == "ipc").collect();
    // ch::START / ch::STATE are constants, not literal strings at the match site;
    // the entry must carry the resolved channel value, never the raw "ch::START" text.
    assert!(!ipc.iter().any(|(_, name, ..)| name.contains("ch::")), "{ipc:?}");
    assert!(ipc.iter().any(|(_, name, ..)| name == "klauro-analysis:start"), "{ipc:?}");
}

#[test]
fn plain_string_comparisons_outside_a_dispatcher_enter_nothing() {
    let held = entries("dispatch-negative");
    assert!(
        !held.iter().any(|(kind, ..)| kind == "http" || kind == "ipc"),
        "a helper comparing an ordinary \"mode\" string must not be read as a router or ipc dispatcher: {held:?}"
    );
}
