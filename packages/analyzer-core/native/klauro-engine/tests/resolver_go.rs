mod common;

use common::calls;

fn index() -> serde_json::Value {
    common::read("resolver_go")
}

#[test]
fn a_package_qualified_call_finds_its_function_in_any_file_of_the_package() {
    let index = index();
    assert!(calls(&index, "cmd/main.go:function:fill", "pkg/cart/cart.go:function:NewCart"));
    assert!(calls(&index, "cmd/main.go:function:other", "pkg/wishlist/wishlist.go:function:NewCart"));
}

#[test]
fn a_function_declared_in_a_sibling_file_of_the_same_package_resolves_unqualified() {
    let index = index();
    assert!(
        calls(&index, "pkg/cart/methods.go:function:Total", "pkg/cart/discount.go:function:discount"),
        "discount lives in another file of package cart; the other package's discount must not be chosen"
    );
}

#[test]
fn a_method_receiver_declared_in_another_file_of_the_package_is_its_type() {
    let index = index();
    assert!(
        calls(&index, "pkg/cart/methods.go:function:Add", "pkg/cart/methods.go:function:Total"),
        "c.Total() inside (c *Cart) Add"
    );
}

#[test]
fn a_local_bound_from_a_constructor_reaches_the_methods_of_its_own_package_type() {
    let index = index();
    assert!(calls(&index, "cmd/main.go:function:fill", "pkg/cart/methods.go:function:Add"));
    assert!(calls(&index, "cmd/main.go:function:fill", "pkg/cart/methods.go:function:Total"));
    assert!(calls(&index, "cmd/main.go:function:other", "pkg/wishlist/wishlist.go:function:Total"));
    assert!(!calls(&index, "cmd/main.go:function:other", "pkg/cart/methods.go:function:Total"));
}

#[test]
fn the_first_result_of_a_multiple_return_is_the_declared_first_type() {
    let index = index();
    assert!(
        calls(&index, "cmd/main.go:function:loaded", "pkg/cart/methods.go:function:Total"),
        "c, err := cart.Load(..) binds c to *Cart"
    );
}
