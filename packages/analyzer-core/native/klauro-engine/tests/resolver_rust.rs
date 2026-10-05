mod common;

use common::calls;

fn index() -> serde_json::Value {
    common::read("resolver_rust")
}

#[test]
fn a_builder_chain_reaches_each_method_through_the_declared_return_types() {
    let index = index();
    let from = "app/src/main.rs:function:chained";
    assert!(calls(&index, from, "builder.rs:function:width@Builder"), "Builder::new().width(..)");
    assert!(calls(&index, from, "builder.rs:function:build"), "..width(4).build()");
    assert!(calls(&index, from, "builder.rs:function:width@Printer"), "printer.width() must reach the method, not the field");
}

#[test]
fn a_local_bound_from_a_function_call_takes_the_functions_return_type() {
    let index = index();
    let from = "app/src/main.rs:function:from_a_function";
    assert!(calls(&index, from, "builder.rs:function:sink"), "make_printer().sink()");
    assert!(calls(&index, from, "sink.rs:function:flush"), "sink bound from printer.sink()");
}

#[test]
fn a_type_re_exported_through_a_grouped_use_resolves_across_the_crate_boundary() {
    let index = index();
    let from = "app/src/main.rs:function:through_a_static_path";
    assert!(calls(&index, from, "sink.rs:function:open"), "Sink::open reached through pub use crate::{{sink::Sink}}");
    assert!(calls(&index, from, "sink.rs:function:flush"), "the bound local is a Sink");
}

#[test]
fn a_returned_self_is_the_owning_type() {
    let index = index();
    assert!(
        calls(&index, "builder.rs:function:make_printer", "builder.rs:function:build"),
        "Builder::new() returns Builder, so .build() belongs to Builder"
    );
}
