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
fn a_build_file_that_names_an_artifact_ships_and_one_that_names_a_library_does_not() {
    let index = common::read("artifact");
    assert_eq!(
        shipped(&index),
        ["", "app"],
        "the web project and the launchable application ship; the libraries beside them do not"
    );
}
