mod common;

fn shipped(index: &serde_json::Value) -> Vec<&str> {
    index["scope"]["deployables"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|unit| unit["category"] == "shipped" && unit["bundled_into"].is_null())
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
fn a_dockerfile_in_a_tooling_directory_ships_the_application_beside_it() {
    let index = common::read("tooling");
    assert_eq!(shipped(&index), [""], "the unit roots at what it builds, not where it lives");
    assert_eq!(index["scope"]["unassigned_nodes"], 0);
}

#[test]
fn a_script_that_installs_the_build_is_not_a_ship_artifact() {
    let index = common::read("tooling");
    let declared: Vec<&str> = index["scope"]["deployables"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|unit| unit["declarations"].as_array().unwrap())
        .map(|found| found["at"].as_str().unwrap())
        .collect();
    assert!(
        !declared.iter().any(|at| at.starts_with(".github/")),
        "continuous integration installs the build, not the product: {declared:?}"
    );
}
