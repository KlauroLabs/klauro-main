mod common;

fn shipped(index: &serde_json::Value) -> Vec<&str> {
    index["scope"]["deployables"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|unit| unit["category"] == "shipped")
        .map(|unit| unit["root"].as_str().unwrap())
        .collect()
}

#[test]
fn two_containers_built_from_one_context_are_two_units() {
    let index = common::read("context");
    assert_eq!(
        shipped(&index),
        ["services/api", "services/worker"],
        "each Dockerfile is its own unit, however wide the context it builds from"
    );
}

#[test]
fn code_outside_both_belongs_to_each_that_reaches_it() {
    let index = common::read("context");
    assert_eq!(
        index["scope"]["shared_nodes"], 1,
        "the helper both containers copy belongs to both"
    );
}

#[test]
#[ignore = "a Dockerfile in a tooling directory that holds a script of its own roots there \
            rather than at the context it builds, so the application it ships is unassigned"]
fn a_dockerfile_in_a_tooling_directory_ships_the_application_beside_it() {
    let index = common::read("tooling");
    assert_eq!(shipped(&index), [""], "the unit roots at what it builds, not where it lives");
    assert_eq!(index["scope"]["unassigned_nodes"], 0);
}
