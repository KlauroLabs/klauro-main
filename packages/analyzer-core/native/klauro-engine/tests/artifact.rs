mod common;

fn shipped(index: &serde_json::Value) -> Vec<&str> {
    index["scope"]["deployables"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|unit| unit["category"] == "shipped")
        .map(|unit| unit["root"].as_str().unwrap())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
}

#[test]
fn a_launchable_application_ships_and_an_executable_build_target_only_runs() {
    let index = common::read("artifact");
    assert_eq!(
        shipped(&index),
        ["app"],
        "the launchable application is a shipped package; the web project only runs and the libraries beside them are neither"
    );
    let category = |root: &str| {
        index["scope"]["deployables"]
            .as_array()
            .unwrap()
            .iter()
            .find(|unit| unit["root"] == root)
            .unwrap_or_else(|| panic!("{root} is a unit"))["category"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_eq!(category(""), "runnable");
    assert_eq!(category("library"), "library");
}
