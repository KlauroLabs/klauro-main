mod common;

use common::calls;

fn index() -> serde_json::Value {
    common::read("resolver_csharp")
}

#[test]
fn a_foreach_variable_takes_the_element_type_of_the_collection() {
    let index = index();
    assert!(calls(&index, "Shop.cs:function:Loop", "Shop.cs:function:Total@Item"));
    assert!(!calls(&index, "Shop.cs:function:Loop", "Shop.cs:function:Total@Other"));
}

#[test]
fn a_linq_lambda_parameter_takes_the_element_type_of_the_sequence() {
    let index = index();
    assert!(calls(&index, "Shop.cs:callback:Select", "Shop.cs:function:Total@Item"));
    assert!(calls(&index, "Shop.cs:callback:Sum", "Shop.cs:function:Total@Item"));
}

#[test]
fn a_standard_collection_element_is_a_standard_type() {
    let index = index();
    let standard = index["edges"].as_array().unwrap().iter().any(|edge| {
        edge["kind"] == "calls"
            && common::names(edge["source"].as_str().unwrap(), "Shop.cs:callback:Where")
            && edge["target"].as_str().unwrap().contains("StartsWith")
    });
    assert!(standard, "n.StartsWith is a call on a string");
}
