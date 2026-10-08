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
    let kept: Vec<(&str, &str)> = registering["steps"].as_array().unwrap().iter().filter_map(|step| Some((step["kind"].as_str()?, step["object"].as_str()?))).collect();
    assert!(kept.contains(&("keep", "AccountUser")), "a write through a shared helper names the record the flow keeps, not the helper: {kept:?}");
}

#[test]
fn a_record_kept_by_a_part_belongs_to_that_part() {
    for entity in entities("entities/kept") {
        assert_eq!(entity["project"], "subproject:kept", "{entity}");
    }
}

#[test]
fn the_bodies_an_entry_point_takes_and_gives_are_not_records_when_nothing_keeps_them() {
    assert_eq!(named(&entities("entities/contract")), Vec::<&str>::new());
    assert_eq!(named(&entities("entities/wire")), Vec::<&str>::new());
}

#[test]
fn a_flow_that_only_answers_with_a_body_writes_no_record() {
    let index = common::read("entities/contract");
    let flows = index["comprehension"]["flows"].as_array().unwrap();
    let creating = flows.iter().find(|flow| flow["id"].as_str().is_some_and(|id| id.contains("method:create"))).unwrap();
    assert!(strings(&creating["writes"]).is_empty(), "{creating}");
}

#[test]
fn a_document_kept_in_a_key_value_store_is_a_record_with_its_items_and_a_body_held_in_memory_is_not() {
    let index = common::read("kv_basket");
    assert_eq!(named(index["comprehension"]["entities"].as_array().unwrap()), vec!["CartLine", "CustomerCart"]);
    let line = index["comprehension"]["entities"].as_array().unwrap().iter().find(|entity| entity["declared_as"] == "CartLine").unwrap();
    assert_eq!(line["part_of"], "CustomerCart", "an item nothing keeps on its own is part of the record that holds it");
    assert!(line["standing"].is_null(), "whether a record is what the system is about is a model's judgement, absent without one");
    let kept: Vec<(&str, &str)> = index["comprehension"]["flows"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|flow| flow["steps"].as_array().unwrap())
        .filter_map(|step| Some((step["kind"].as_str()?, step["object"].as_str()?)))
        .filter(|(kind, _)| matches!(*kind, "keep" | "read" | "remove"))
        .collect();
    assert!(kept.contains(&("keep", "CustomerCart")) && kept.contains(&("read", "CustomerCart")) && kept.contains(&("remove", "CustomerCart")), "{kept:?}");
    let previewing = index["comprehension"]["flows"].as_array().unwrap().iter().find(|flow| flow["surface"] == "/preview").expect("the preview is a flow");
    assert!(
        previewing["steps"].as_array().unwrap().iter().all(|step| step["object"] != "CustomerCart"),
        "a same-named shape built in memory is not the stored record: {previewing}"
    );
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

#[test]
fn a_model_is_the_definition_that_reaches_the_orm_base_and_a_namesake_elsewhere_never_stands_for_it() {
    let held = entities("entities/collision");
    let mut places: Vec<&str> = held.iter().filter_map(|entity| entity["id"].as_str()).collect();
    places.sort();
    assert_eq!(
        places,
        vec!["entity:scheduling/models.py:type:CustomSchedule", "entity:shop/models.py:type:Product", "entity:shop/models.py:type:ProductTranslation"]
    );
}

#[test]
fn a_view_with_more_fields_than_the_model_it_shares_a_name_with_never_replaces_the_model() {
    let held = entities("entities/views");
    let places: Vec<&str> = held.iter().filter_map(|entity| entity["id"].as_str()).collect();
    assert_eq!(places, vec!["entity:shop/models.py:type:Order"]);
}

#[test]
fn tables_map_to_the_types_their_mappings_configure_and_a_dropped_or_framework_table_is_no_record_of_its_own() {
    let held = entities("entities/ef_records");
    assert_eq!(named(&held), vec!["AuditEntry", "Order", "ShippingLabel", "ShopUser", "Tag"], "a reverted, dropped or linking table and the framework's own tables are no record of their own");
    let label = held.iter().find(|entity| entity["declared_as"] == "ShippingLabel").unwrap();
    assert!(label["named_fields"].as_array().unwrap().iter().any(|field| field["name"] == "trackingcode"), "a renamed table still belongs to the set named after it: {label}");
    let order = held.iter().find(|entity| entity["declared_as"] == "Order").unwrap();
    assert!(order["references"].as_array().unwrap().iter().any(|reference| reference["entity"] == "Tag" && reference["cardinality"] == "N:M"), "a table of two keys links the records it keys: {order}");
    let user = held.iter().find(|entity| entity["declared_as"] == "ShopUser").unwrap();
    let fields: Vec<&str> = user["named_fields"].as_array().unwrap().iter().filter_map(|field| field["name"].as_str()).collect();
    assert!(fields.contains(&"email") && fields.contains(&"DisplayName"), "the framework's user table folds into the type that extends it: {fields:?}");
}
