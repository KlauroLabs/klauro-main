mod common;

fn index() -> serde_json::Value {
    common::read("ship")
}

fn shipped(index: &serde_json::Value) -> Vec<&serde_json::Value> {
    index["scope"]["deployables"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|unit| unit["shipped"] == true)
        .collect()
}

#[test]
fn a_build_file_beside_an_entry_point_ships_what_it_builds() {
    let index = index();
    let units = shipped(&index);
    let roots: Vec<&str> = units.iter().map(|unit| unit["root"].as_str().unwrap()).collect();
    assert_eq!(roots, vec!["src/tool"], "the program ships, the library beside it does not");
}

#[test]
fn the_code_a_shipped_unit_builds_is_assigned_to_it() {
    let index = index();
    let units = shipped(&index);
    assert!(units[0]["units"].as_u64().unwrap() >= 2, "main and its helper belong to the program");
    assert_eq!(
        index["scope"]["unassigned_nodes"], 1,
        "the library the program never imports is not shipped by it"
    );
}
