mod common;

fn index() -> serde_json::Value {
    common::read("ship")
}

fn shipped(index: &serde_json::Value) -> Vec<&serde_json::Value> {
    index["scope"]["deployables"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|unit| unit["category"] == "shipped")
        .collect()
}

fn category_of(index: &serde_json::Value, root: &str) -> String {
    index["scope"]["deployables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|unit| unit["root"] == root)
        .unwrap_or_else(|| panic!("{root} is a unit"))["category"]
        .as_str()
        .unwrap()
        .to_string()
}

#[test]
fn an_executable_build_target_ships_and_the_library_beside_it_does_not() {
    let index = index();
    assert_eq!(category_of(&index, "src/tool"), "shipped");
    assert_eq!(category_of(&index, "lib"), "library");
    let roots: Vec<&str> = shipped(&index).iter().map(|unit| unit["root"].as_str().unwrap()).collect();
    assert_eq!(roots, vec!["src/tool"], "only the executable target is built to ship");
}

#[test]
fn a_build_file_beside_an_entry_point_makes_a_project_of_what_it_builds() {
    let index = index();
    let roots: Vec<&str> = index["scope"]["deployables"]
        .as_array()
        .unwrap()
        .iter()
        .map(|unit| unit["root"].as_str().unwrap())
        .collect();
    assert!(roots.contains(&"src/tool"), "the program is a project: {roots:?}");
    assert!(roots.contains(&"lib"), "so is the library beside it: {roots:?}");
}

#[test]
fn a_compose_file_naming_two_services_declares_two_units() {
    let index = common::read("scope");
    let services: Vec<&str> = index["scope"]["deployables"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|unit| {
            unit["declarations"]
                .as_array()
                .unwrap()
                .iter()
                .any(|found| found["kind"] == "compose-service")
        })
        .map(|unit| unit["name"].as_str().unwrap())
        .collect();
    assert_eq!(services, ["api", "worker"], "each service is its own unit");
}
