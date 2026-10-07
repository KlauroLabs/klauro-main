mod common;

#[test]
fn every_way_a_dotnet_app_is_entered_is_an_entry() {
    let index = common::read("surfaces");
    let mut entered: Vec<String> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| matches!(entry["kind"].as_str(), Some("http" | "rpc")))
        .map(|entry| {
            format!(
                "{} {} {}",
                entry["kind"].as_str().unwrap(),
                entry["method"].as_str().unwrap_or("-"),
                entry["path"].as_str().unwrap_or("-")
            )
        })
        .collect();
    entered.sort();
    assert_eq!(
        entered,
        vec![
            "http GET /Account/Login",
            "http GET /Account/Profile",
            "http GET /api/hooks",
            "http GET /health",
            "http GET /items/{id}",
            "http POST /Account/Login",
            "http POST /api/hooks/received",
            "http POST /v1/analyze",
            "http PUT /api/hooks",
            "rpc - /Basket/GetBasket",
        ]
    );
    let cart = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["path"] == "/cart")
        .unwrap();
    assert_eq!(cart["kind"], "ui", "a Razor page is a screen");
    assert_eq!(cart["guards"][0]["name"], "Authorize");
}

#[test]
fn a_hosted_background_service_is_entered_when_the_host_starts() {
    let index = common::read("surfaces");
    let started: Vec<&str> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "background")
        .filter_map(|entry| entry["handler"].as_str())
        .collect();
    assert!(started.iter().any(|handler| handler.contains("ExecuteAsync")), "{started:?}");
}

#[test]
fn a_route_handled_inline_is_handled_by_its_own_lambda() {
    let index = common::read("surfaces");
    let handlers: Vec<&str> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["path"].as_str().is_some_and(|path| path.starts_with("/api/hooks")))
        .filter_map(|entry| entry["handler"].as_str())
        .collect();
    assert_eq!(handlers.len(), 3, "{handlers:?}");
    assert!(handlers.iter().all(|handler| handler.contains(":callback:")), "{handlers:?}");
}

#[test]
fn a_handler_subscribed_to_a_bus_is_entered_by_the_messages_it_receives() {
    let index = common::read("surfaces");
    let received: Vec<(String, String)> = index["entry_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "message")
        .map(|entry| (entry["name"].as_str().unwrap().to_string(), entry["handler"].as_str().unwrap().to_string()))
        .collect();
    assert!(
        received.iter().any(|(name, handler)| name == "OrderPaid" && handler.contains("Payments.cs:function:Handle")),
        "{received:?}"
    );
}

#[test]
fn a_message_handed_to_the_bus_is_published_to_whoever_receives_it() {
    let index = common::read("surfaces");
    let mut published: Vec<(String, String)> = index["exit_points"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|exit| exit["kind"] == "message" && exit["source"].as_str().unwrap_or_default().starts_with("Worker/Checkout.cs"))
        .map(|exit| (exit["source"].as_str().unwrap().rsplit(':').next().unwrap().to_string(), exit["target"].as_str().unwrap().to_string()))
        .collect();
    published.sort();
    assert_eq!(
        published,
        vec![("Settle".to_string(), "OrderPaid".to_string()), ("Settle".to_string(), "OrderRefused".to_string())],
        "both branches publish; logging the message or keeping it in a list publishes nothing"
    );
}
