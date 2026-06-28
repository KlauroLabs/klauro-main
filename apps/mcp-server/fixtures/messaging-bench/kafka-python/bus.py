from kafka import KafkaProducer, KafkaConsumer


def publish_order(order):
    producer = KafkaProducer(bootstrap_servers="localhost:9092")
    producer.send("orders", order)


def consume_shipments():
    consumer = KafkaConsumer("shipments", bootstrap_servers="localhost:9092")
    for msg in consumer:
        pass
