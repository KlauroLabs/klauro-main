mod common;

fn reaches_the_implementer(index: &serde_json::Value, caller: &str) -> bool {
    index["edges"].as_array().unwrap().iter().any(|edge| {
        edge["kind"] == "calls"
            && edge["via"] == "rule"
            && edge["source"].as_str().unwrap().ends_with(&format!(":{caller}"))
            && edge["target"].as_str().unwrap().ends_with(":function:spawn")
    })
}

#[test]
fn a_call_on_a_field_typed_by_a_generic_bound_reaches_the_implementers() {
    let index = common::read("bound_dispatch");
    assert!(reaches_the_implementer(&index, "function:start"), "{}", index["edges"]);
}

#[test]
fn a_call_on_an_impl_trait_argument_reaches_the_implementers() {
    let index = common::read("bound_dispatch");
    assert!(reaches_the_implementer(&index, "function:run_with_argument"), "{}", index["edges"]);
}

#[test]
fn a_call_on_a_where_bounded_parameter_reaches_the_implementers() {
    let index = common::read("bound_dispatch");
    assert!(reaches_the_implementer(&index, "function:run_with_bound"), "{}", index["edges"]);
}
