mod common;

use std::collections::BTreeMap;

use serde_json::Value;

fn services(fixture: &str) -> BTreeMap<String, Value> {
    let index = common::read(fixture);
    index["services"]
        .as_array()
        .unwrap()
        .iter()
        .map(|service| (service["name"].as_str().unwrap().to_string(), service.clone()))
        .collect()
}

fn evidenced(service: &Value, how: &str) -> u64 {
    service["evidenced"]
        .as_array()
        .unwrap()
        .iter()
        .find(|pair| pair[0] == how)
        .map(|pair| pair[1].as_u64().unwrap())
        .unwrap_or(0)
}

#[test]
fn every_service_the_system_talks_to_is_named_with_its_evidence() {
    let found = services("services");
    let named: Vec<&str> = found.keys().map(String::as_str).collect();
    assert_eq!(named, vec!["PostHog", "PostgreSQL", "Redis", "Sentry", "Stripe", "api.acme-rates.io"]);

    let stripe = &found["Stripe"];
    assert_eq!(stripe["kind"], "payments");
    assert!(evidenced(stripe, "package") >= 1);
    assert!(evidenced(stripe, "setting") >= 1);
    assert_eq!(evidenced(stripe, "call"), 2);

    let postgres = &found["PostgreSQL"];
    assert!(evidenced(postgres, "image") >= 1);
    assert!(evidenced(postgres, "connection") >= 1);

    let unknown = &found["api.acme-rates.io"];
    assert_eq!(unknown["known"], false);
    assert_eq!(unknown["reached"], 1);
}

#[test]
fn a_call_through_a_service_client_reaches_that_service() {
    let index = common::read("services");
    let reached: Vec<(String, String)> = index["exit_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|exit| exit["target"] == "stripe")
        .map(|exit| (exit["kind"].as_str().unwrap().to_string(), exit["operation"].as_str().unwrap().to_string()))
        .collect();
    assert!(reached.iter().all(|(kind, _)| kind == "api"), "{reached:?}");
    assert!(reached.iter().any(|(_, operation)| operation.ends_with("expire")), "{reached:?}");
}
