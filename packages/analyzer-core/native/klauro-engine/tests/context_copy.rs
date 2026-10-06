mod common;

fn unit<'a>(index: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
    index["scope"]["deployables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|unit| unit["name"] == name)
        .unwrap_or_else(|| panic!("{name} is a unit"))
}

#[test]
fn a_container_that_only_copies_the_context_ships_the_programs_it_builds_and_not_the_crate_it_sits_in() {
    let index = common::read("context_copy");
    assert_eq!(unit(&index, "svc")["category"], "shipped");
    assert_eq!(unit(&index, "root-tool")["category"], "runnable");
}
