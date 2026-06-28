use async_nats::Client;

// publish_orders emits to the orders subject.
async fn publish_orders(client: &Client) {
    client.publish("orders", "created".into()).await.unwrap();
}

// subscribe_shipments consumes the shipments subject.
async fn subscribe_shipments(client: &Client) {
    let _sub = client.subscribe("shipments").await.unwrap();
}
