mod common;

use serde_json::Value;

fn parts(fixture: &str) -> Vec<Value> {
    common::read(fixture)["partition"]["sub_projects"].as_array().unwrap().clone()
}

fn roots(all: &[Value]) -> Vec<String> {
    let mut found: Vec<String> = all.iter().map(|part| part["root"].as_str().unwrap().to_string()).collect();
    found.sort();
    found
}

fn part<'a>(all: &'a [Value], root: &str) -> &'a Value {
    all.iter().find(|held| held["root"] == root).unwrap_or_else(|| panic!("{root} is a part: {:?}", roots(all)))
}

#[test]
fn a_test_project_belongs_to_the_part_it_tests() {
    let all = parts("units_tests");
    assert!(!roots(&all).contains(&"packages/app-tests".to_string()), "{:?}", roots(&all));
    assert_eq!(part(&all, "packages/app")["members"], serde_json::json!(["packages/app-tests"]));
}

#[test]
fn a_published_package_stays_its_own_part_though_one_part_uses_it() {
    let all = parts("units_tests");
    part(&all, "packages/sdk");
}

#[test]
fn a_crate_only_one_part_depends_on_through_its_manifest_is_a_component_of_that_part() {
    let all = parts("units_cargo");
    assert_eq!(roots(&all), vec!["crates/app".to_string()]);
    assert_eq!(part(&all, "crates/app")["members"], serde_json::json!(["crates/store"]));
}

#[test]
fn a_platform_folder_of_a_cross_platform_app_belongs_to_the_app() {
    let all = parts("units_flutter");
    assert!(!roots(&all).iter().any(|root| root.starts_with("mobile/android")), "{:?}", roots(&all));
    assert!(part(&all, "mobile")["members"].as_array().unwrap().iter().any(|member| member == "mobile/android/app"));
}
