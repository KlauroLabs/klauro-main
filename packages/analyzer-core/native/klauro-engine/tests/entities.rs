mod common;

use serde_json::Value;

fn entities(fixture: &str) -> Vec<Value> {
    common::read(fixture)["comprehension"]["entities"].as_array().unwrap().clone()
}

fn named(held: &[Value]) -> Vec<&str> {
    let mut names: Vec<&str> = held.iter().filter_map(|entity| entity["declared_as"].as_str()).collect();
    names.sort();
    names
}

fn strings(value: &Value) -> Vec<&str> {
    value.as_array().map(|held| held.iter().filter_map(Value::as_str).collect()).unwrap_or_default()
}

#[test]
fn a_type_persisted_through_a_file_is_a_record_and_the_option_bags_and_props_beside_it_are_not() {
    let held = entities("entities/kept");
    assert_eq!(named(&held), vec!["AccountUser", "AccountWorkspace"]);
}

#[test]
fn a_record_is_linked_to_the_flows_that_write_it_and_the_flows_that_read_it() {
    let index = common::read("entities/kept");
    let entities = index["comprehension"]["entities"].as_array().unwrap();
    let flows = index["comprehension"]["flows"].as_array().unwrap();
    let workspace = entities.iter().find(|entity| entity["declared_as"] == "AccountWorkspace").unwrap();
    let writing = strings(&workspace["written_in"]);
    let reading = strings(&workspace["read_in"]);
    assert!(writing.iter().any(|id| id.contains("app.post@#2")), "{writing:?}");
    assert!(reading.iter().any(|id| id.contains("app.get")), "{reading:?}");
    assert!(!workspace["written_by"].as_array().unwrap().is_empty());
    assert!(!workspace["read_by"].as_array().unwrap().is_empty());
    let registering = flows.iter().find(|flow| flow["id"].as_str().is_some_and(|id| id.contains("app.post@#1") && !id.ends_with("published"))).unwrap();
    assert_eq!(strings(&registering["writes"]), vec!["AccountUser"]);
    let listing = flows.iter().find(|flow| flow["id"] == "flow:entry:src/server.ts:callback:app.get").unwrap();
    assert_eq!(strings(&listing["reads"]), vec!["AccountWorkspace"]);
    assert_eq!(workspace["project"], registering["project"]);
}

#[test]
fn a_record_kept_by_a_part_belongs_to_that_part() {
    for entity in entities("entities/kept") {
        assert_eq!(entity["project"], "subproject:kept", "{entity}");
    }
}

#[test]
fn the_bodies_an_entry_point_takes_and_gives_are_records_and_a_plain_helper_shape_is_not() {
    let held = entities("entities/contract");
    assert_eq!(named(&held), vec!["CreateOrderDto", "OrderView"]);
}

#[test]
fn a_serde_struct_an_ipc_command_takes_or_gives_is_a_record_and_a_plain_struct_is_not() {
    let held = entities("entities/wire");
    assert_eq!(named(&held), vec!["Draft", "Note"]);
}

#[test]
fn a_request_body_is_written_by_the_flow_that_takes_it() {
    let index = common::read("entities/contract");
    let flows = index["comprehension"]["flows"].as_array().unwrap();
    let creating = flows.iter().find(|flow| flow["id"].as_str().is_some_and(|id| id.contains("method:create"))).unwrap();
    assert_eq!(strings(&creating["writes"]), vec!["CreateOrderDto"]);
    assert_eq!(strings(&creating["reads"]), vec!["OrderView"]);
}

fn references<'a>(held: &'a [Value], entity: &str) -> Vec<(&'a str, &'a str, &'a str)> {
    let Some(found) = held.iter().find(|candidate| candidate["declared_as"] == entity) else { return Vec::new() };
    found["references"]
        .as_array()
        .map(|references| {
            references
                .iter()
                .map(|reference| {
                    (
                        reference["field"].as_str().unwrap_or_default(),
                        reference["entity"].as_str().unwrap_or_default(),
                        reference["cardinality"].as_str().unwrap_or_default(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn an_active_record_model_relates_to_its_neighbours_with_a_cardinality_and_a_plain_class_is_not_an_entity() {
    let held = entities("entities/orm");
    assert_eq!(references(&held, "Author"), vec![("books", "Book", "1:N"), ("profile", "AuthorProfile", "1:1")]);
    assert_eq!(references(&held, "Book"), vec![("author", "Author", "N:1"), ("tags", "Tag", "N:M")]);
    assert!(!named(&held).contains(&"SearchForm"));
}

#[test]
fn an_eloquent_model_relates_through_its_relation_methods_and_a_model_inheriting_a_shared_base_counts() {
    let held = entities("entities/orm");
    assert_eq!(references(&held, "Team"), vec![("members", "Member", "1:N"), ("projects", "Project", "N:M")]);
    assert_eq!(references(&held, "Member"), vec![("team", "Team", "N:1")]);
    assert_eq!(references(&held, "Project"), vec![("teams", "Team", "N:M")]);
    assert!(!named(&held).contains(&"BaseModel"));
}

#[test]
fn a_doctrine_entity_relates_through_attributes_and_annotations_and_a_plain_value_class_is_not_an_entity() {
    let held = entities("entities/orm");
    assert_eq!(references(&held, "Client"), vec![("account", "Account", "1:1"), ("invoices", "Invoice", "1:N")]);
    assert_eq!(references(&held, "Invoice"), vec![("client", "Client", "N:1")]);
    assert!(!named(&held).contains(&"Money"));
}

#[test]
fn a_sqlalchemy_relationship_takes_its_cardinality_from_the_side_that_holds_the_foreign_key() {
    let held = entities("entities/orm");
    assert_eq!(references(&held, "Department"), vec![("staff", "Employee", "1:N")]);
    assert_eq!(references(&held, "Employee"), vec![("badge", "Badge", "1:1"), ("department", "Department", "N:1")]);
    assert_eq!(references(&held, "Badge"), vec![("employee_id", "Employee", "N:1")]);
}

#[test]
fn a_django_model_relates_through_its_relation_fields_wherever_the_target_is_spelled() {
    let held = entities("entities/orm");
    assert_eq!(
        references(&held, "Shop"),
        vec![("owner", "Owner", "1:1"), ("region", "Region", "N:1"), ("suppliers", "Supplier", "N:M")]
    );
}

#[test]
fn a_django_model_inherits_its_mapping_through_an_abstract_base_whichever_base_it_lists_and_a_generic_wrapper_is_not_a_model() {
    let held = entities("entities/orm");
    assert_eq!(references(&held, "Ledger"), vec![("shop", "Shop", "N:1")]);
    assert!(!named(&held).contains(&"ShopType"));
    assert!(!named(&held).contains(&"Audited"));
}

#[test]
fn a_mongoose_model_registered_over_a_schema_relates_through_its_ref_fields() {
    let held = entities("entities/orm");
    assert_eq!(references(&held, "Album"), vec![("tracks", "Track", "1:N")]);
    assert_eq!(references(&held, "Track"), vec![("album", "Album", "N:1")]);
}

#[test]
fn a_jpa_entity_relates_with_the_cardinality_its_annotation_declares() {
    let held = entities("entities/orm");
    assert_eq!(
        references(&held, "Student"),
        vec![("courses", "Course", "N:M"), ("enrollments", "Enrollment", "1:N"), ("passport", "Passport", "1:1")]
    );
    assert_eq!(references(&held, "Enrollment"), vec![("student", "Student", "N:1")]);
}

#[test]
fn an_orm_mapped_entity_names_the_mapping_that_makes_it_persisted() {
    let held = entities("entities/orm");
    let cited = |entity: &str| held.iter().find(|candidate| candidate["declared_as"] == entity).and_then(|found| found["persisted_by"].as_str());
    assert_eq!(cited("Author"), Some("extends ApplicationRecord"));
    assert_eq!(cited("Client"), Some("#[ORM\\Entity]"));
    assert_eq!(cited("Student"), Some("@Entity"));
    assert_eq!(cited("Album"), Some("mongoose Schema"));
    assert_eq!(cited("Helper"), None);
    assert_eq!(cited("Department"), Some("__tablename__ = departments"));
}
