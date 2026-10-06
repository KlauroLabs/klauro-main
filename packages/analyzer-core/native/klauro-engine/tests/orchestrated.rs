mod common;

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
fn an_orchestrator_ships_the_services_it_references_and_an_unreferenced_executable_only_runs() {
    let index = common::read("orchestrated");
    assert_eq!(category_of(&index, "host"), "shipped");
    assert_eq!(category_of(&index, "api"), "shipped");
    assert_eq!(category_of(&index, "worker"), "shipped");
    assert_eq!(category_of(&index, "tool"), "runnable");
    assert_eq!(category_of(&index, "lib"), "library");
}
