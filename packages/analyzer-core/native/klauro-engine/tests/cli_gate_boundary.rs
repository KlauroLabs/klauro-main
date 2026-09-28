mod common;

fn index() -> serde_json::Value {
    common::read("cli_gate_boundary")
}

fn cli_names(index: &serde_json::Value) -> Vec<String> {
    index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "cli")
        .filter_map(|entry| entry["name"].as_str().map(str::to_string))
        .collect()
}

#[test]
fn a_cli_command_in_the_shipped_program_stays_an_entry() {
    let names = cli_names(&index());
    assert!(names.iter().any(|name| name == "build"), "{names:?}");
    assert!(names.iter().any(|name| name == "test"), "{names:?}");
}

#[test]
fn a_cli_command_in_an_unshipped_standalone_program_is_not_an_entry() {
    let names = cli_names(&index());
    assert!(
        !names.iter().any(|name| name == "start" || name == "stop"),
        "gauntlet-tool.ts ships nothing, so its cli commands are dev tooling: {names:?}"
    );
}
