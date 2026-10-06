mod common;

#[test]
fn a_representative_journey_starts_at_a_served_route_and_reaches_the_process_it_starts() {
    let index = common::read("journey-entry");
    let journeys = index["journeys"].as_array().unwrap();
    let representative: Vec<&serde_json::Value> = journeys.iter().filter(|journey| journey["representative"] == true).collect();
    assert!(!representative.is_empty(), "{journeys:?}");
    let order = representative.iter().find(|journey| journey["label"] == "Create order and start an external process").expect("the route and its ending title the journey");
    let symbols: Vec<&str> = order["steps"].as_array().unwrap().iter().map(|step| step["symbol"].as_str().unwrap()).collect();
    assert_eq!(symbols, vec!["placeOrder", "launch", "start", "begin"]);
    assert_eq!(order["steps"].as_array().unwrap().last().unwrap()["effect"].as_str().unwrap().split(':').next(), Some("process"));
}

#[test]
fn no_representative_journey_is_titled_by_a_file_or_is_shorter_than_three_steps() {
    let index = common::read("journey-relay");
    for journey in index["journeys"].as_array().unwrap().iter().filter(|journey| journey["representative"] == true) {
        assert!(!journey["label"].as_str().unwrap().contains('/'), "{journey:?}");
        assert!(journey["steps"].as_array().unwrap().len() >= 3, "{journey:?}");
    }
}
