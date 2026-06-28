package com.example;

import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.annotation.KafkaListener;

public class FulfilmentService {
    private final KafkaTemplate<String, String> kafkaTemplate;

    public FulfilmentService(KafkaTemplate<String, String> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    public void publishOrder(String payload) {
        kafkaTemplate.send("orders", payload);
    }

    // Listens to two topics declared as an array.
    @KafkaListener(topics = {"shipments", "returns"}, groupId = "svc")
    public void onEvent(String message) {
        // handle
    }
}
