mod common;

use common::calls;

fn index() -> serde_json::Value {
    common::read("laravel")
}

fn entries(index: &serde_json::Value) -> Vec<&serde_json::Value> {
    index["entry_points"].as_array().unwrap().iter().filter(|e| e["kind"] == "http").collect()
}

#[test]
fn a_router_vouches_for_a_path_written_without_a_leading_slash() {
    let index = index();
    let found = entries(&index);
    let paths: Vec<&str> = found.iter().map(|e| e["path"].as_str().unwrap_or("")).collect();
    assert!(paths.contains(&"addresses"), "Route::get('addresses', ...) is a route: {paths:?}");
    assert_eq!(found.len(), 2, "the two routes, and nothing else: {paths:?}");
}

#[test]
fn reading_a_key_off_a_collection_is_not_a_route() {
    let index = index();
    assert!(
        !entries(&index).iter().any(|e| e["path"] == "etag"),
        "$collection->get('etag') reads a key, and no router vouches for it"
    );
}

#[test]
fn a_route_is_served_by_the_controller_rather_than_the_file_it_is_written_in() {
    let index = index();
    for entry in entries(&index) {
        let handler = entry["handler"].as_str().unwrap();
        assert!(
            handler.contains("AddressController"),
            "the handler is the controller, not the route file: {handler}"
        );
    }
}


#[test]
fn a_call_on_the_enclosing_instance_resolves_through_its_sigil() {
    let index = index();
    assert!(
        calls(&index, "function:index:7", "function:render:17"),
        "$this->render() is a call on the enclosing class"
    );
}

#[test]
fn a_typed_parameter_types_the_receiver_it_names() {
    let index = index();
    assert!(
        calls(&index, "function:notify:15", "function:deliver:7"),
        "$mailer is declared Mailer, so $mailer->deliver() is Mailer::deliver"
    );
}
