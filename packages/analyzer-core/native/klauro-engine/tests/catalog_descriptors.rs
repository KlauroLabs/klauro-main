mod common;

use serde_json::Value;

fn projects() -> Vec<Value> {
    common::read("catalog_units")["partition"]["sub_projects"].as_array().unwrap().clone()
}

fn project<'a>(all: &'a [Value], root: &str) -> &'a Value {
    all.iter()
        .find(|part| part["root"] == root)
        .unwrap_or_else(|| panic!("{root} is a sub-project: {:?}", all.iter().map(|part| &part["root"]).collect::<Vec<_>>()))
}

#[test]
fn a_component_descriptor_declares_a_sub_project_with_its_owner_system_and_dependencies() {
    let all = projects();
    let orders = project(&all, "services/orders");
    assert_eq!(orders["declared_by"], "catalog-descriptor");
    assert_eq!(orders["name"], "orders-service");
    assert_eq!(orders["owner"], "team-commerce");
    assert_eq!(orders["system"], "checkout");
    assert_eq!(orders["depends_on"], serde_json::json!(["component:billing-service", "resource:orders-db"]));
    assert_eq!(project(&all, "services/billing")["declared_by"], "catalog-descriptor");
}

#[test]
fn a_system_descriptor_groups_units_and_declares_none() {
    let all = projects();
    assert!(all.iter().all(|part| part["root"] != "libs/ledger"), "{all:?}");
}

#[test]
fn a_module_manifest_outranks_a_descriptor_in_the_same_directory_and_the_descriptor_still_names_the_owner() {
    let all = projects();
    let payments = project(&all, "services/payments");
    assert_eq!(payments["declared_by"], "module-manifest");
    assert_eq!(payments["owner"], "team-payments");
}
