mod common;

use common::calls;

fn index() -> serde_json::Value {
    common::read("resolver_python")
}

#[test]
fn a_local_bound_from_a_function_takes_its_declared_return_type() {
    let index = index();
    assert!(calls(&index, "shop.py:function:from_a_function", "shop.py:function:total@Item"));
    assert!(!calls(&index, "shop.py:function:from_a_function", "shop.py:function:total@Other"));
}

#[test]
fn a_loop_variable_takes_the_element_type_of_the_annotated_list() {
    let index = index();
    assert!(calls(&index, "shop.py:function:looped", "shop.py:function:total@Item"));
    assert!(!calls(&index, "shop.py:function:looped", "shop.py:function:total@Other"));
}

#[test]
fn a_comprehension_variable_takes_the_element_type_of_the_iterable() {
    let index = index();
    assert!(calls(&index, "shop.py:function:comprehended", "shop.py:function:total@Item"));
    assert!(!calls(&index, "shop.py:function:comprehended", "shop.py:function:total@Other"));
}
