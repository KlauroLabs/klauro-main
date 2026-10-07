using Shop.Bus;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapPost("/orders/{id}/pay", async (int id, IEventBus eventBus) =>
{
    var paid = new OrderPaid(id);
    await eventBus.PublishAsync(paid);
});
app.Run();
