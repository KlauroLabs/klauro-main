package main

import (
	kafka "github.com/segmentio/kafka-go"
)

// invoiceWriter publishes to the invoices topic (struct-literal idiom).
func invoiceWriter() *kafka.Writer {
	return &kafka.Writer{
		Addr:  kafka.TCP("localhost:9092"),
		Topic: "invoices",
	}
}

// paymentReader consumes the payments topic.
func paymentReader() *kafka.Reader {
	return kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"localhost:9092"},
		Topic:   "payments",
	})
}
