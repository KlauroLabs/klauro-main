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
            ("/cart/count".to_string(), "/Cart/GetCart".to_string(), "subproject:Shop.Cart".to_string(), into("/Cart/GetCart")),
            ("/checkout".to_string(), "POST /api/orders".to_string(), "subproject:Shop.Orders".to_string(), into("/api/orders")),
            ("/orders/summary".to_string(), "GET /api/orders/summary".to_string(), "subproject:Shop.Orders".to_string(), into("/api/orders/summary")),
            ("/orders/{id}".to_string(), "GET /api/orders/{id:int}".to_string(), "subproject:Shop.Orders".to_string(), into("/api/orders/{id:int}")),
        ],
        "a group's prefix reaches every route on it, a path variable lands on a route variable, each method keeps its own local, and a generated service client lands on the service's rpc"
    );
    let checkout = flows.iter().find(|flow| flow["surface"] == "/checkout").unwrap();
    assert!(checkout["steps"].as_array().unwrap().iter().any(|step| !step["lands_in"].as_array().map(Vec::is_empty).unwrap_or(true)), "the calling step names where it lands: {checkout}");
}

#[test]
fn starting_another_parts_program_through_a_wrapped_launcher_is_a_seam_into_that_program() {
    let index = common::read("start_seams");
    let seams = index["comprehension"]["seams"].as_array().unwrap();
    let started: Vec<(&str, &str, &str)> = seams
        .iter()
        .map(|seam| (seam["from"].as_str().unwrap(), seam["via"].as_str().unwrap(), seam["to"].as_str().unwrap()))
        .collect();
    assert_eq!(started, vec![("subproject:api", "start", "subproject:indexer")]);
    assert!(seams[0]["to_flows"].as_array().unwrap().iter().any(|flow| flow.as_str().unwrap().contains("indexer/src/main.rs")), "{seams:?}");
}

#[test]
fn starting_a_program_is_a_step_that_names_the_program_and_checking_for_a_file_is_no_step() {
    let index = common::read("start_seams");
    let flow = index["comprehension"]["flows"].as_array().unwrap().iter().find(|flow| flow["surface"] == "/repositories/index").unwrap();
    let steps: Vec<(&str, &str)> = flow["steps"].as_array().unwrap().iter().map(|step| (step["kind"].as_str().unwrap(), step["object"].as_str().unwrap_or_default())).collect();
    assert!(steps.iter().any(|(kind, object)| *kind == "run" && !object.is_empty() && *object != "another program"), "{steps:?}");
    assert!(steps.iter().all(|(kind, _)| *kind != "read"), "an existence check prepares, it reads no record: {steps:?}");
}

#[test]
fn a_message_type_several_handlers_take_lands_on_the_one_whose_queue_names_the_channel() {
    let index = common::read("channel_seams");
    let seams = index["comprehension"]["seams"].as_array().unwrap();
    let landed: Vec<(&str, &str)> = seams
        .iter()
        .map(|seam| (seam["to_entry"].as_str().unwrap(), seam["by"].as_str().unwrap()))
        .collect();
    assert_eq!(landed.len(), 1, "{landed:?}");
    assert!(landed[0].0.contains("RebuildIndexWorker") && landed[0].1 == "channel", "{landed:?}");
}
