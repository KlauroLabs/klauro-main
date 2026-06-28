package main

import (
	"context"

	kafka "github.com/segmentio/kafka-go"
)

// produceOrders publishes domain events to the orders topic.
func produceOrders() {
	writer := kafka.NewWriter(kafka.WriterConfig{
		Brokers: []string{"localhost:9092"},
		Topic:   "orders",
	})
	writer.WriteMessages(context.Background(), kafka.Message{Value: []byte("created")})
}

// consumeShipments reads shipment updates from the shipments topic.
func consumeShipments() {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"localhost:9092"},
		Topic:   "shipments",
	})
	reader.ReadMessage(context.Background())
}
