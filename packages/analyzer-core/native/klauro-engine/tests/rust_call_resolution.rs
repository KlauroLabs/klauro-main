mod common;

use common::calls;

fn index() -> serde_json::Value {
    common::read("handed_off_by_return_type")
}

#[test]
fn a_sibling_module_declared_without_use_resolves_its_call() {
    let index = index();
    assert!(
        calls(&index, "archive/mod.rs:function:delete_session", "layout.rs:function:delete_session"),
        "mod layout; should bring the sibling module into scope for layout::delete_session(..)"
    );
}

#[test]
fn a_binding_from_a_result_returning_call_resolves_through_the_reference() {
    let index = index();
    assert!(
        calls(&index, "archive/mod.rs:function:dispatch", "archive/mod.rs:function:delete_session"),
        "a = global()?; a.delete_session(..) should follow the Result<&Archive> return type"
    );
}

#[test]
fn a_binding_from_an_arc_returning_call_resolves_through_the_wrapper() {
    let index = index();
    assert!(
        calls(&index, "archive/mod.rs:function:dispatch", "get@Store"),
        "cached = shared(); cached.get() should unwrap Arc<Store> to reach Store::get"
    );
}

#[test]
fn unwrap_after_an_option_of_box_still_resolves_to_the_inner_type() {
    let index = index();
    let found = index["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|edge| {
            edge["kind"] == "calls"
                && common::names(edge["source"].as_str().unwrap(), "archive/mod.rs:function:dispatch")
                && common::names(edge["target"].as_str().unwrap(), "get@Store")
        })
        .count();
    assert!(found >= 2, "both cached.get() and found.get() should reach Store::get, found {found}");
}

#[test]
fn an_associated_function_call_reached_across_a_workspace_crate_resolves() {
    let index = index();
    assert!(
        calls(&index, "app/src/main.rs:function:boot", "archive/mod.rs:function:delete_session"),
        "core_lib::archive::global()?.delete_session(..) should reach across the workspace crate boundary"
    );
}

#[test]
fn a_self_field_access_resolves_to_the_fields_declared_type() {
    let index = index();
    assert!(
        calls(&index, "archive/mod.rs:function:read", "get@Store"),
        "self.store.get() should follow the field's declared type, not guess by bare name"
    );
}
