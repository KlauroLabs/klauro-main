mod common;

fn addressed(index: &serde_json::Value, operation: &str) -> Option<String> {
    index["exit_points"]
        .as_array()
        .unwrap()
        .iter()
        .find(|exit| exit["operation"] == operation)
        .and_then(|exit| exit["addressed"].as_str().map(str::to_string))
}

#[test]
fn a_request_built_before_it_is_sent_is_addressed_where_it_was_built() {
    let index = common::read("requests");
    assert_eq!(addressed(&index, "SendAsync").as_deref(), Some("/api/loans/"));
}

#[test]
fn a_request_address_written_from_a_base_field_is_folded() {
    let index = common::read("requests");
    assert_eq!(addressed(&index, "GetFromJsonAsync").as_deref(), Some("/api/loans/{id}"));
}
