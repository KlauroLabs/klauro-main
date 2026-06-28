package com.example;

import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Service;

@Service
public class OrderService {
    private final KafkaTemplate<String, String> kafkaTemplate;

    public OrderService(KafkaTemplate<String, String> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    // publishOrder produces domain events to the orders topic.
    public void publishOrder(String payload) {
        kafkaTemplate.send("orders", payload);
    }

    // onShipment consumes the shipments topic.
    @KafkaListener(topics = "shipments", groupId = "svc")
    public void onShipment(String message) {
        // handle shipment update
    }
}
