use rdkafka::producer::{FutureProducer, FutureRecord};
use rdkafka::consumer::{Consumer, StreamConsumer};

async fn produce_orders(producer: &FutureProducer) {
    let record = FutureRecord::to("orders").payload("x").key("k");
    let _ = producer.send(record, std::time::Duration::from_secs(0)).await;
}

// Subscribes to two topics in a single slice.
fn consume_fulfilment(consumer: &StreamConsumer) {
    consumer.subscribe(&["shipments", "returns"]).expect("subscribe failed");
}
