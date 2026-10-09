mod common;

fn exports(index: &serde_json::Value) -> Vec<(String, String)> {
    index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "public")
        .map(|entry| (entry["handler"].as_str().unwrap_or_default().to_string(), entry["registrar"].as_str().unwrap_or_default().to_string()))
        .collect()
}

#[test]
fn a_library_nothing_calls_offers_its_public_methods() {
    let index = common::read("csharp_library_nobody_calls");
    let exports = exports(&index);
    assert!(exports.iter().any(|(handler, _)| handler.ends_with("Statements.cs:function:Fetch")), "{exports:#?}");
    assert!(exports.iter().all(|(handler, _)| !handler.ends_with(":function:Hidden")), "{exports:#?}");
}

#[test]
fn a_part_that_already_has_an_entry_lists_no_public_methods() {
    let index = common::read("csharp_library_nobody_calls");
    let exports = exports(&index);
    assert!(exports.iter().all(|(handler, _)| !handler.starts_with("Payments/") && !handler.starts_with("Shop/")), "{exports:#?}");
}
