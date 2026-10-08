mod common;

#[test]
fn a_call_to_another_parts_route_is_a_seam_into_the_flow_that_serves_it() {
    let index = common::read("http_seams");
    let flows = index["comprehension"]["flows"].as_array().unwrap();
    let surface = |id: &str| flows.iter().find(|flow| flow["id"] == id).and_then(|flow| flow["surface"].as_str()).unwrap_or_default().to_string();
    let mut seams: Vec<(String, String, String, Vec<String>)> = index["comprehension"]["seams"]
        .as_array()
        .unwrap()
        .iter()
        .map(|seam| {
            (
                surface(seam["from_flow"].as_str().unwrap()),
                seam["carries"].as_str().unwrap().to_string(),
                seam["to"].as_str().unwrap().to_string(),
                seam["to_flows"].as_array().unwrap().iter().map(|flow| surface(flow.as_str().unwrap())).collect(),
            )
        })
        .collect();
    seams.sort();
    let into = |path: &str| vec![path.to_string()];
    assert_eq!(
        seams,
        vec![
            ("/checkout".to_string(), "POST /api/orders".to_string(), "subproject:Shop.Orders".to_string(), into("/api/orders")),
            ("/orders/summary".to_string(), "GET /api/orders/summary".to_string(), "subproject:Shop.Orders".to_string(), into("/api/orders/summary")),
            ("/orders/{id}".to_string(), "GET /api/orders/{id:int}".to_string(), "subproject:Shop.Orders".to_string(), into("/api/orders/{id:int}")),
        ],
        "a group's prefix reaches every route on it, a path variable lands on a route variable, and each method keeps its own local"
    );
    let checkout = flows.iter().find(|flow| flow["surface"] == "/checkout").unwrap();
    assert!(checkout["steps"].as_array().unwrap().iter().any(|step| !step["lands_in"].as_array().map(Vec::is_empty).unwrap_or(true)), "the calling step names where it lands: {checkout}");
}
