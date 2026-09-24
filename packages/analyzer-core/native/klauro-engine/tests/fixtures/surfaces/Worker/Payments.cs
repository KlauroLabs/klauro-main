namespace Shop.Worker;

public record OrderPaid(int OrderId) : IntegrationEvent;

public class OrderPaidHandler(IOrders orders) : IIntegrationEventHandler<OrderPaid>
{
    public async Task Handle(OrderPaid @event)
    {
        await orders.Confirm();
    }
}

public static class Subscriptions
{
    public static void Subscribe(IEventBusBuilder eventBus)
    {
        eventBus.AddSubscription<OrderPaid, OrderPaidHandler>();
    }
}
