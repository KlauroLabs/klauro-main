using Shop.Bus;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapPost("/orders/{id}/pay", async (int id, IEventBus eventBus) =>
{
    var paid = new OrderPaid(id);
    await eventBus.PublishAsync(paid);
});
app.MapPost("/orders/{id}/settle", async (int id, bool approved, IEventBus eventBus) =>
{
    if (approved)
    {
        await eventBus.PublishAsync(new OrderPaid(id));
    }
    else
    {
        await eventBus.PublishAsync(new OrderRefused(id));
    }
});
app.Run();
