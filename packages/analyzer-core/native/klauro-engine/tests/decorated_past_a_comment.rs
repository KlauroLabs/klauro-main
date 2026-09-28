mod common;

#[test]
fn a_comment_between_the_decorators_and_the_function_does_not_hide_its_route() {
    let index = common::read("decorated_past_a_comment");
    let paths: Vec<&str> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "http")
        .map(|entry| entry["path"].as_str().unwrap_or(""))
        .collect();
    assert!(paths.contains(&"/reports/<key>"), "{paths:?}");
    assert!(paths.contains(&"/plain"), "{paths:?}");
}
