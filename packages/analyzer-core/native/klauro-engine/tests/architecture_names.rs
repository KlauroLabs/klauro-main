mod common;

fn named(fixture: &str) -> Vec<String> {
    let index = common::read(fixture);
    index["patterns"]["found"]
        .as_array()
        .unwrap()
        .iter()
        .map(|found| found["pattern"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn controllers_answering_requests_over_models_are_model_view_controller_even_when_they_render_json() {
    let held = named("architecture-names/rails-json");
    assert!(held.contains(&"model-view-controller".to_string()), "{held:?}");
}

#[test]
fn a_static_instance_typed_as_a_nullable_union_is_still_a_singleton() {
    let held = named("architecture-names/ts-singleton");
    assert!(held.contains(&"singleton".to_string()), "{held:?}");
}

#[test]
fn a_handler_named_for_its_command_that_takes_a_declared_message_is_a_command_handler() {
    let held = named("architecture-names/handler-by-name");
    assert!(held.contains(&"command handlers".to_string()), "{held:?}");
}

#[test]
fn a_send_through_a_mediator_is_a_mediator_even_when_the_handler_lives_elsewhere() {
    let held = named("architecture-names/mediator-send");
    assert!(held.contains(&"mediator".to_string()), "{held:?}");
}
