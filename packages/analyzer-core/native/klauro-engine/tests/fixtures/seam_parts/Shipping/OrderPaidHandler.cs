using Microsoft.EntityFrameworkCore;
using Shop.Bus;

public class Shipment
{
    public int Id { get; set; }
    public int OrderId { get; set; }
}

public class ShippingContext : DbContext
{
    public DbSet<Shipment> Shipments => Set<Shipment>();
}

public class OrderPaidHandler(ShippingContext context) : IIntegrationEventHandler<OrderPaid>
{
    public async Task Handle(OrderPaid @event)
    {
        context.Shipments.Add(new Shipment { OrderId = @event.OrderId });
        await context.SaveChangesAsync();
    }
}

public class OrderRefusedHandler(ShippingContext context) : IIntegrationEventHandler<OrderRefused>
{
    public async Task Handle(OrderRefused @event)
    {
        await context.SaveChangesAsync();
    }
}
