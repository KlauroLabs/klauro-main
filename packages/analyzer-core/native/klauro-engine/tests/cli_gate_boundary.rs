mod common;

fn index() -> serde_json::Value {
    common::read("cli_gate_boundary")
}

fn cli_names_where(index: &serde_json::Value, tagged: bool) -> Vec<String> {
    index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "cli")
        .filter(|entry| entry.get("unshipped").is_some() == tagged)
        .filter_map(|entry| entry["name"].as_str().map(str::to_string))
        .collect()
}

#[test]
fn a_cli_command_in_the_shipped_program_stays_an_entry() {
    let names = cli_names_where(&index(), false);
    assert!(names.iter().any(|name| name == "build"), "{names:?}");
    assert!(names.iter().any(|name| name == "test"), "{names:?}");
}

#[test]
fn a_cli_command_in_an_unshipped_standalone_program_stays_an_entry_tagged_as_tooling() {
    let index = index();
    let shipped = cli_names_where(&index, false);
    assert!(
        !shipped.iter().any(|name| name == "start" || name == "stop"),
        "gauntlet-tool.ts ships nothing, so its cli commands are not shipped entries: {shipped:?}"
    );
    let tagged = cli_names_where(&index, true);
    assert!(
        tagged.iter().any(|name| name == "start") && tagged.iter().any(|name| name == "stop"),
        "the commands are kept and tagged: {tagged:?}"
    );
}
