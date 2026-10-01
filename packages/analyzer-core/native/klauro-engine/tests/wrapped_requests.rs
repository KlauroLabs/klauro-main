mod common;

fn asked(fixture: &str) -> Vec<(String, String, String)> {
    let index = common::read(fixture);
    let mut held: Vec<(String, String, String)> = index["exit_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|exit| exit["kind"] == "api" && exit["addressed"].is_string())
        .map(|exit| {
            let source = exit["source"].as_str().unwrap().split(':').nth(2).unwrap_or("").to_string();
            (source, exit["operation"].as_str().unwrap().to_string(), exit["addressed"].as_str().unwrap().to_string())
        })
        .collect();
    held.sort();
    held
}

#[test]
fn a_call_to_a_request_wrapper_asks_the_route_and_method_it_names() {
    let held = asked("request-wrapper");
    assert!(held.contains(&("cancelOrder".into(), "POST".into(), "/api/orders/{id}/cancel".into())), "{held:?}");
    assert!(held.contains(&("listOrders".into(), "GET".into(), "/api/orders".into())), "{held:?}");
}

#[test]
fn a_function_that_never_reaches_the_wrapper_asks_nothing() {
    let held = asked("request-wrapper");
    assert!(!held.iter().any(|(source, _, _)| source == "describe"), "{held:?}");
    assert!(!held.iter().any(|(source, _, _)| source == "apiRequest"), "{held:?}");
}
