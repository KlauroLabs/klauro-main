mod common;

fn calls(index: &serde_json::Value, from: &str, to: &str) -> bool {
    index["edges"].as_array().unwrap().iter().any(|edge| {
        edge["kind"] == "calls"
            && edge["source"].as_str().unwrap().contains(from)
            && edge["target"].as_str().unwrap().contains(to)
    })
}

#[test]
fn an_inner_class_reaches_the_member_its_outer_class_was_handed() {
    let index = common::read("reach_kotlin");
    assert!(calls(&index, "Prefs.kt:callback", "ObservableSettings:settings.getBoolean"));
}

#[test]
fn a_value_written_by_index_into_device_settings_is_kept_on_the_device() {
    let index = common::read("reach_kotlin");
    let kept: Vec<&str> = index["exit_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|exit| exit["kind"] == "client_storage")
        .map(|exit| exit["operation"].as_str().unwrap())
        .collect();
    assert!(kept.contains(&"set"), "{kept:?}");
}

#[test]
fn a_call_through_a_typed_property_reaches_an_extension_and_its_receiver() {
    let index = common::read("reach_kotlin");
    assert!(calls(&index, "Screen.kt:callback", "Screen.kt:function:toggle"));
    assert!(calls(&index, "Screen.kt:function:toggle", "Screen.kt:function:set"));
}

#[test]
fn a_value_kept_by_a_scope_function_stands_for_what_its_lambda_returns() {
    let index = common::read("reach_kotlin");
    assert!(calls(&index, "Paged.kt:function:present", "Paged.kt:function:load"));
}
