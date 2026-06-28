package main

import (
	"github.com/nats-io/nats.go"
)

// publishOrders emits to the orders subject.
func publishOrders(nc *nats.Conn) {
	nc.Publish("orders", []byte("created"))
}

// subscribeShipments consumes the shipments subject.
func subscribeShipments(nc *nats.Conn) {
	nc.Subscribe("shipments", func(m *nats.Msg) {})
}
