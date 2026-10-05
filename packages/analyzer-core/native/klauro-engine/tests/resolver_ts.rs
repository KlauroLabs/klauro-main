mod common;

use common::calls;

fn index() -> serde_json::Value {
    common::read("resolver_ts")
}

fn reaches(index: &serde_json::Value, source: &str, target_fragment: &str) -> bool {
    index["edges"].as_array().unwrap().iter().any(|edge| {
        edge["kind"] == "calls"
            && common::names(edge["source"].as_str().unwrap(), source)
            && edge["target"].as_str().unwrap().contains(target_fragment)
    })
}

#[test]
fn an_array_callback_parameter_takes_the_element_type_of_the_array() {
    let index = index();
    assert!(calls(&index, "use.ts:callback:rows.forEach", "store.ts:method:total@Row"));
    assert!(!calls(&index, "use.ts:callback:rows.forEach", "store.ts:method:total@Ledger"));
}

#[test]
fn a_for_of_variable_takes_the_element_type_of_the_iterable() {
    let index = index();
    assert!(calls(&index, "use.ts:function:sumLoop", "store.ts:method:total@Row"));
    assert!(!calls(&index, "use.ts:function:sumLoop", "store.ts:method:total@Ledger"));
}

#[test]
fn a_parameter_of_the_enclosing_function_is_seen_from_inside_a_callback() {
    let index = index();
    assert!(calls(&index, "use.ts:callback:ids.forEach", "store.ts:method:save@Store"));
    assert!(calls(&index, "use.ts:callback:ids.forEach", "store.ts:method:get@Store"));
    assert!(!calls(&index, "use.ts:callback:ids.forEach", "store.ts:method:save@Cache"));
}

#[test]
fn a_callback_parameter_shadows_the_enclosing_name() {
    let index = index();
    assert!(calls(&index, "use.ts:callback:rows.map", "store.ts:method:total@Row"), "store here is a Row, not the outer Store");
    assert!(!reaches(&index, "use.ts:callback:rows.map", "total@Ledger"));
}

#[test]
fn a_literal_receiver_is_the_runtime_type_it_writes() {
    let index = index();
    assert!(reaches(&index, "use.ts:function:literals", "RegExp.test"));
    assert!(reaches(&index, "use.ts:function:literals", "Array.includes"));
}
