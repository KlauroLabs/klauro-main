use rdkafka::producer::{FutureProducer, FutureRecord};
use rdkafka::consumer::{Consumer, StreamConsumer};

// produce_orders publishes domain events to the orders topic.
async fn produce_orders(producer: &FutureProducer) {
    let record = FutureRecord::to("orders").payload("created").key("k");
    let _ = producer.send(record, std::time::Duration::from_secs(0)).await;
}

// consume_shipments reads shipment updates from the shipments topic.
fn consume_shipments(consumer: &StreamConsumer) {
    consumer.subscribe(&["shipments"]).expect("subscribe failed");
}
