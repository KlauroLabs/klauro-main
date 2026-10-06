mod common;

fn deployables(fixture: &str) -> Vec<serde_json::Value> {
    common::read(fixture)["scope"]["deployables"].as_array().unwrap().clone()
}

fn named<'a>(units: &'a [serde_json::Value], name: &str) -> &'a serde_json::Value {
    units.iter().find(|unit| unit["name"] == name).unwrap_or_else(|| panic!("{name} is a deployable"))
}

#[test]
fn a_script_that_places_built_outputs_on_the_path_ships_the_units_it_builds_whatever_it_is_called() {
    let units = deployables("installer_evidence");
    let installer = named(&units, "root");
    assert_eq!(installer["category"], "shipped");
    let mut shipped: Vec<&str> = installer["ships"].as_array().unwrap().iter().map(|root| root.as_str().unwrap()).collect();
    shipped.sort();
    assert_eq!(shipped, ["app", "helper"], "the build command and the copied outputs name the two crates");
}

#[test]
fn the_member_that_launches_the_others_is_the_primary() {
    let units = deployables("installer_evidence");
    let app = named(&units, "app");
    let helper = named(&units, "helper");
    assert!(app["bundled_into"].is_null(), "the launcher leads: {app}");
    assert_eq!(helper["bundled_into"], app["id"], "the launched crate is bundled into it");
    assert_eq!(app["category"], "shipped");
}

#[test]
fn members_with_no_evidence_of_which_leads_stay_members_of_the_installer_unit() {
    let units = deployables("installer_undecided");
    let installer = named(&units, "root");
    assert_eq!(installer["category"], "shipped");
    for member in ["app", "helper"] {
        assert_eq!(named(&units, member)["bundled_into"], installer["id"], "{member} is carried by the installer, not folded into a guessed primary");
    }
}

#[test]
fn scripts_that_remove_link_system_files_or_install_dependencies_ship_nothing() {
    let units = deployables("installer_negatives");
    let shipped: Vec<&str> = units.iter().filter(|unit| unit["category"] == "shipped").map(|unit| unit["name"].as_str().unwrap()).collect();
    assert!(shipped.is_empty(), "no uninstall, postinstall or dependency script is a ship unit: {shipped:?}");
}
