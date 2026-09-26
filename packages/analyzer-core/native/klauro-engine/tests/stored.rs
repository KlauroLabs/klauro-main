mod common;

use serde_json::Value;

fn entities(fixture: &str) -> Vec<(String, Vec<String>)> {
    let index = common::read(fixture);
    let mut held: Vec<(String, Vec<String>)> = index["comprehension"]["entities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entity| {
            let fields = entity["named_fields"]
                .as_array()
                .map(|fields| fields.iter().filter_map(|field| field["name"].as_str()).map(str::to_string).collect())
                .unwrap_or_default();
            (entity["declared_as"].as_str().unwrap().to_string(), fields)
        })
        .collect();
    held.sort();
    held
}

fn named(held: &[(String, Vec<String>)]) -> Vec<&str> {
    held.iter().map(|(name, _)| name.as_str()).collect()
}

fn fields_of<'a>(held: &'a [(String, Vec<String>)], name: &str) -> &'a [String] {
    &held.iter().find(|(named, _)| named == name).unwrap().1
}

#[test]
fn a_record_is_what_a_migration_creates_and_never_a_shape_handed_to_a_caller() {
    let rails = entities("stored/rails");
    assert_eq!(named(&rails), vec!["Account", "StatusEdit", "Webhook", "settings"]);
    assert_eq!(fields_of(&rails, "Account"), ["username", "email"]);
    assert_eq!(fields_of(&rails, "StatusEdit"), ["account", "text"]);

    let laravel = entities("stored/laravel");
    assert_eq!(named(&laravel), vec!["Contact", "LifeEvent"]);
    assert_eq!(fields_of(&laravel, "Contact"), ["first_name", "last_name"]);

    assert_eq!(named(&entities("stored/django")), vec!["Order"]);
    assert_eq!(named(&entities("stored/alembic")), vec!["Dashboard"]);
    assert_eq!(named(&entities("stored/efcore")), vec!["CatalogBrand"]);
    assert_eq!(named(&entities("stored/sqlmodel")), vec!["User"]);
}

#[test]
fn a_migration_is_read_as_the_schema_it_creates() {
    let index: Value = common::read("stored/alembic");
    let entity = index["comprehension"]["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entity| entity["declared_as"] == "Dashboard")
        .cloned()
        .unwrap();
    let fields: Vec<&str> = entity["named_fields"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|field| field["name"].as_str())
        .collect();
    assert!(fields.contains(&"dashboard_title"), "{fields:?}");
}

#[test]
fn a_stored_record_is_the_one_its_own_code_can_see_not_a_namesake_elsewhere() {
    let index = common::read("stored/projects");
    let declared: Vec<&str> = index["comprehension"]["entities"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|entity| entity["declared_in"].as_str())
        .collect();
    assert_eq!(declared, vec!["Ordering.Domain/Order.cs:type:Order"]);
}

#[test]
fn a_class_declared_under_a_namespace_is_named_for_itself() {
    let index = common::read("stored/rails");
    let named: Vec<&str> = index["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|node| node["file"] == index["files"].as_array().unwrap().iter().position(|file| file["path"] == "app/workers/webhooks/delivery_worker.rb").unwrap())
        .filter(|node| node["kind"] == "class")
        .filter_map(|node| node["name"].as_str())
        .collect();
    assert_eq!(named, vec!["DeliveryWorker"]);
}

#[test]
fn one_table_written_for_several_databases_is_one_record() {
    let held: Vec<String> = entities("stored/dialects")
        .into_iter()
        .map(|(name, _)| name.to_ascii_lowercase())
        .collect();
    assert_eq!(held, vec!["qrtz_triggers", "report_card"]);
}

#[test]
fn the_schema_is_what_the_migrations_leave_standing_and_an_enum_is_never_a_record() {
    let held: Vec<String> = entities("stored/replayed")
        .into_iter()
        .map(|(name, _)| name.to_ascii_lowercase())
        .collect();
    assert_eq!(held, vec!["user"]);
    let index = common::read("stored/replayed");
    assert_eq!(index["comprehension"]["entities"][0]["declared_in"], "prisma/schema.prisma:type:User");
}

#[test]
fn a_reversal_never_takes_back_what_the_migration_made() {
    let held: Vec<String> = entities("stored/reversed").into_iter().map(|(name, _)| name).collect();
    assert_eq!(held, vec!["tasks", "users"]);
}

#[test]
fn a_model_mapped_onto_a_table_is_that_table() {
    let held: Vec<String> = entities("stored/mapped").into_iter().map(|(name, _)| name).collect();
    assert_eq!(held, vec!["User"]);
}

#[test]
fn a_table_an_ef_migration_creates_holds_the_columns_its_members_name() {
    let held = entities("stored/efidentity");
    assert_eq!(named(&held), vec!["aspnetroles"]);
    assert_eq!(fields_of(&held, "aspnetroles"), &["id", "name", "concurrencystamp"]);
}
