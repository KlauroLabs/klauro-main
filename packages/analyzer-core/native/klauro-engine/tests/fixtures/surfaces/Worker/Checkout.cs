namespace Shop.Worker;

public record OrderRefused(int OrderId) : IntegrationEvent;

public class RefusedHandler(IOrders orders) : IIntegrationEventHandler<OrderRefused>
{
    public async Task Handle(OrderRefused @event)
    {
        await orders.Confirm();
    }
}

public class Checkout(IEventBus eventBus, ILogger<Checkout> logger)
{
    public async Task Settle(int orderId, bool paid)
    {
        IntegrationEvent outcome;
        if (paid)
        {
            outcome = new OrderPaid(orderId);
        }
        else
        {
            outcome = new OrderRefused(orderId);
        }
        logger.LogInformation("Settling {Order}", outcome);
        await eventBus.PublishAsync(outcome);
    }

    public async Task Remember(OrderPaid paid, List<OrderPaid> history)
    {
        history.Add(paid);
        await Task.CompletedTask;
    }
}

public static class MoreSubscriptions
{
    public static void Subscribe(IEventBusBuilder eventBus)
    {
        eventBus.AddSubscription<OrderRefused, RefusedHandler>();
    }
}
