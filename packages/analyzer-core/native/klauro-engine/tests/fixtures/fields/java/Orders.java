package shop.orders;

interface OrderRepository {
    void add(Order order);
}

class Order {
    int id;
}

class CreateOrderHandler {
    private final OrderRepository orderRepository;

    CreateOrderHandler(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    void handle(Order order) {
        orderRepository.add(order);
    }
}
