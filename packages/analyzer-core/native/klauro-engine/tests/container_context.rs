mod common;

fn roots_in(index: &serde_json::Value, category: &str) -> Vec<String> {
    let mut found: Vec<String> = index["scope"]["deployables"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|unit| unit["category"] == category)
        .map(|unit| unit["root"].as_str().unwrap().to_string())
        .collect();
    found.sort();
    found
}

#[test]
fn a_dockerfile_copying_its_whole_context_ships_the_directory_it_sits_in() {
    let index = common::read("container_context");
    let shipped = roots_in(&index, "shipped");
    assert!(shipped.contains(&"apps/web".to_string()), "{shipped:?}");
    assert!(shipped.contains(&"apps/api".to_string()), "{shipped:?}");
}

#[test]
fn a_dockerfile_named_for_a_service_builds_from_a_context_its_invoker_chooses_so_it_ships_nothing_beside_itself() {
    let index = common::read("container_context");
    let shipped = roots_in(&index, "shipped");
    assert!(!shipped.contains(&"docker".to_string()), "{shipped:?}");
}

#[test]
fn a_shared_package_beside_the_services_is_not_shipped_by_a_dockerfile_that_does_not_copy_it() {
    let index = common::read("container_context");
    assert!(!roots_in(&index, "shipped").contains(&"packages/ui".to_string()));
}
