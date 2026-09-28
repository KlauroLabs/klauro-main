mod common;

fn cli_entries(fixture: &str) -> Vec<String> {
    let index = common::read(fixture);
    index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "cli")
        .filter_map(|entry| entry["name"].as_str().map(str::to_string))
        .collect()
}

fn has_kind(fixture: &str, kind: &str) -> bool {
    let index = common::read(fixture);
    index["entry_points"].as_array().unwrap().iter().any(|entry| entry["kind"] == kind)
}

#[test]
fn a_js_argv_if_chain_with_aliases_enters_each_command() {
    let held = cli_entries("dispatch-argv-js");
    for command in ["build", "test", "start", "stop"] {
        assert!(held.iter().any(|held| held == command), "expected {command} in {held:?}");
    }
}

#[test]
fn a_js_argv_switch_enters_each_case() {
    let held = cli_entries("dispatch-argv-js");
    assert!(held.iter().any(|held| held == "start"), "{held:?}");
    assert!(held.iter().any(|held| held == "stop"), "{held:?}");
}

#[test]
fn a_python_sys_argv_if_chain_enters_each_command() {
    let held = cli_entries("dispatch-argv-py");
    assert!(held.iter().any(|held| held == "sync"), "{held:?}");
    assert!(held.iter().any(|held| held == "status"), "{held:?}");
}

#[test]
fn a_rust_env_args_if_chain_enters_each_command() {
    let held = cli_entries("dispatch-argv-rust");
    assert!(held.iter().any(|held| held == "init"), "{held:?}");
    assert!(held.iter().any(|held| held == "build"), "{held:?}");
}

#[test]
fn a_go_os_args_if_chain_enters_each_command() {
    let held = cli_entries("dispatch-argv-go");
    assert!(held.iter().any(|held| held == "serve"), "{held:?}");
    assert!(held.iter().any(|held| held == "migrate"), "{held:?}");
}

#[test]
fn an_ordinary_string_comparison_unrelated_to_argv_enters_no_cli_command() {
    for fixture in ["dispatch-argv-js", "dispatch-argv-py", "dispatch-argv-rust", "dispatch-argv-go"] {
        assert!(
            !has_kind(fixture, "cli") || !cli_entries(fixture).iter().any(|held| held == "fast" || held == "slow"),
            "an ordinary \"mode\" comparison in {fixture} must not be read as a cli command"
        );
    }
}
