namespace Shop.Orders;

public interface IOrderRepository
{
    void Add(Order order);
}

public class Order
{
    public int Id { get; set; }
}

public class CreateOrderHandler
{
    private readonly IOrderRepository _orderRepository;

    public CreateOrderHandler(IOrderRepository orderRepository)
    {
        _orderRepository = orderRepository;
    }

    public void Handle(Order order)
    {
        _orderRepository.Add(order);
    }
}
