mod common;

use serde_json::Value;

fn wired(index: &Value) -> Vec<(String, String)> {
    let named = |id: &str| -> String {
        index["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["id"] == id)
            .map(|node| node["name"].as_str().unwrap().to_string())
            .unwrap_or_default()
    };
    let mut found: Vec<(String, String)> = index["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|edge| edge["kind"] == "resolved_by")
        .map(|edge| (named(edge["source"].as_str().unwrap()), edge["target"].as_str().unwrap().to_string()))
        .collect();
    found.sort();
    found
}

fn operations(index: &Value) -> Vec<String> {
    let mut found: Vec<String> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "graphql" && entry["method"].is_string())
        .map(|entry| format!("{} {}", entry["method"].as_str().unwrap(), entry["name"].as_str().unwrap()))
        .collect();
    found.sort();
    found
}

fn fields(found: &[(String, String)]) -> Vec<&str> {
    found.iter().map(|(field, _)| field.as_str()).collect()
}

#[test]
fn a_resolver_map_wires_each_schema_field_to_the_function_that_answers_it() {
    let index = common::read("graphql_map");
    let found = wired(&index);
    assert_eq!(fields(&found), ["createUser", "user", "users"], "{found:?}");
    assert!(found.iter().all(|(_, handler)| handler.starts_with("resolvers.ts:resolver:")), "{found:?}");
    assert_eq!(operations(&index), ["mutation Mutation.createUser", "query Query.user", "query Query.users"]);
}

#[test]
fn a_call_inside_an_inline_resolver_belongs_to_that_resolver() {
    let index = common::read("graphql_map");
    let called_from_the_resolver = index["edges"].as_array().unwrap().iter().any(|edge| {
        edge["kind"] == "calls" && edge["source"] == "resolvers.ts:resolver:Query.user"
    }) || index["calls"].as_array().unwrap().iter().any(|call| {
        call["caller"] == "resolvers.ts:resolver:Query.user" && call["callee"] == "findUser"
    });
    assert!(called_from_the_resolver, "findUser is called by Query.user, not by the map that holds it");
}

#[test]
fn a_schema_written_in_a_template_string_is_wired_to_named_resolvers() {
    let index = common::read("graphql_named_map");
    let found = wired(&index);
    assert_eq!(fields(&found), ["createUser", "user", "users"], "{found:?}");
    assert!(found.iter().all(|(_, handler)| handler.starts_with("resolvers.ts:function:")), "named functions are the handlers: {found:?}");
}

#[test]
fn a_graphene_field_reaches_its_resolve_method_through_the_classes_that_compose_the_root() {
    let index = common::read("graphql_graphene");
    let found = wired(&index);
    assert_eq!(fields(&found), ["product", "productCreate"], "{found:?}");
    let mutation = found.iter().find(|(field, _)| field == "productCreate").unwrap();
    assert!(mutation.1.ends_with("perform_mutation"), "the mutation's own member answers it: {mutation:?}");
    assert_eq!(operations(&index), ["mutation Mutation.productCreate", "query Query.product"]);
}

#[test]
fn a_decorated_method_answers_the_field_it_names_rather_than_its_own_name() {
    let index = common::read("graphql_nest");
    let found = wired(&index);
    let handlers: Vec<(&str, &str)> = found.iter().map(|(field, handler)| (field.as_str(), handler.rsplit(':').next().unwrap())).collect();
    assert_eq!(handlers, [("makeUser", "create"), ("posts", "posts"), ("user", "findOne")]);
}

#[test]
fn a_graphql_ruby_field_is_answered_by_the_method_of_the_same_name() {
    let index = common::read("graphql_ruby");
    let found = wired(&index);
    assert_eq!(fields(&found), ["create_user", "user", "users"], "{found:?}");
}

#[test]
fn a_gqlgen_resolver_method_answers_the_field_of_the_type_its_receiver_names() {
    let index = common::read("graphql_gqlgen");
    let found = wired(&index);
    assert_eq!(fields(&found), ["createUser", "user", "users"], "{found:?}");
    assert_eq!(operations(&index), ["mutation Mutation.createUser", "query Query.user", "query Query.users"]);
}

#[test]
fn a_hot_chocolate_operation_class_answers_the_fields_its_methods_name() {
    let index = common::read("graphql_hotchocolate");
    let found = wired(&index);
    assert_eq!(fields(&found), ["createUser", "user", "users"], "Get and Async are not part of the field: {found:?}");
}

#[test]
fn a_code_first_field_has_a_schema_node_of_its_own() {
    let index = common::read("graphql_strawberry");
    let found = wired(&index);
    assert_eq!(fields(&found), ["create_user", "user", "users"], "{found:?}");
    assert_eq!(operations(&index), ["mutation Mutation.create_user", "query Query.user", "query Query.users"]);
}

#[test]
fn a_mutation_that_inherits_its_work_is_answered_by_its_own_class() {
    let index = common::read("graphql_graphene_inherited");
    let found = wired(&index);
    assert_eq!(fields(&found), ["pageCreate"], "{found:?}");
    assert!(found[0].1.ends_with("PageCreate"), "{found:?}");
}
