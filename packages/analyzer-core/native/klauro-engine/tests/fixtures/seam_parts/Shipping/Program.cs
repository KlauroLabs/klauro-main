using Shop.Bus;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddDbContext<ShippingContext>();
var host = builder.Build();
host.Run();

public static class Subscriptions
{
    public static void Subscribe(IEventBusBuilder eventBus)
    {
        eventBus.AddSubscription<OrderPaid, OrderPaidHandler>();
        eventBus.AddSubscription<OrderRefused, OrderRefusedHandler>();
    }
}
