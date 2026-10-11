mod common;

fn public_entries(index: &serde_json::Value) -> Vec<String> {
    let mut named: Vec<String> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "public")
        .map(|entry| entry["name"].as_str().unwrap_or_default().to_string())
        .collect();
    named.sort();
    named
}

#[test]
fn a_kotlin_library_offers_what_it_does_not_mark_private_or_internal() {
    let offered = public_entries(&common::read("kotlin_public_by_default"));
    assert!(offered.contains(&"trending".to_string()) && offered.contains(&"followShow".to_string()), "{offered:?}");
    assert!(!offered.contains(&"cached".to_string()) && !offered.contains(&"hiddenHelper".to_string()), "{offered:?}");
}

#[test]
fn a_library_whose_service_another_program_hosts_still_offers_its_public_methods() {
    let offered = public_entries(&common::read("hosted_library"));
    assert!(offered.contains(&"PrefersIpv6".to_string()) && offered.contains(&"Describe".to_string()), "{offered:?}");
}
