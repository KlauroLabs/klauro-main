mod common;

#[test]
fn a_request_sent_through_a_mediator_reaches_its_one_handler() {
    let index = common::read("messages");
    let messages: Vec<(String, String, usize, usize)> = index["patterns"]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| {
            (
                message["message"].as_str().unwrap().to_string(),
                message["kind"].as_str().unwrap().to_string(),
                message["handlers"].as_array().map(Vec::len).unwrap_or(0),
                message["senders"].as_array().map(Vec::len).unwrap_or(0),
            )
        })
        .collect();
    assert_eq!(
        messages,
        vec![
            ("CreateOrderCommand".to_string(), "command".to_string(), 1, 1),
            ("GetOrdersQuery".to_string(), "query".to_string(), 1, 1),
        ]
    );
    let patterns: Vec<&str> = index["patterns"]["found"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|found| found["pattern"].as_str())
        .collect();
    assert!(patterns.contains(&"mediator") && patterns.contains(&"CQRS"), "{patterns:?}");
    let dispatched = index["edges"].as_array().unwrap().iter().any(|edge| {
        edge["kind"] == "calls"
            && edge["source"].as_str().unwrap().contains(":function:Create")
            && edge["target"].as_str().unwrap().contains(":function:Handle")
    });
    assert!(dispatched);
}
