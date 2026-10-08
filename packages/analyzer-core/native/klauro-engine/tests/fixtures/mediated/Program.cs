using MediatR;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapPost("/refunds/{orderId}", async (int orderId, IMediator mediator) => await mediator.Send(new IssueRefundCommand(orderId)));
app.MapPost("/refunds/{orderId}/remind", async (int orderId, Reminders reminders) => await reminders.NotifyCustomerAsync(orderId));
app.MapGet("/refunds/queued", async (QueuedRefundRepository queuedRefundRepository) => await queuedRefundRepository.GetAll());
app.MapGet("/refunds/audit", async (AuditRefundRepository audits) => await audits.GetAll());
app.MapGet("/refunds/lookup/{orderId}", async (int orderId, bool latest, RefundRepository refunds) =>
{
    if (latest)
    {
        return await refunds.Find(orderId);
    }
    else
    {
        return await refunds.Find(orderId - 1);
    }
});
app.MapPost("/refunds/legacy", (int orderId) =>
{
    throw new InvalidOperationException("Legacy refunds are disabled, use the new refunds route.");
});
app.MapPost("/refunds/{orderId}/approve", async (int orderId, RefundRepository refunds) =>
{
    if (orderId <= 0)
    {
        throw new ArgumentException("The order is not known to us.");
    }
    return await refunds.Find(orderId);
});
app.MapPost("/refunds/{orderId}/archive", async (int orderId, Archive archive) =>
{
    if (orderId <= 0)
    {
        Archive.ThrowNotFound();
    }
    var target = Archive.DispatchTargetFor(orderId);
    return await archive.StoreSnapshot(orderId) + target;
});
app.MapPut("/refunds/v1/{orderId}", async (int orderId, RefundRepository refunds) => await refunds.Register(new Refund { OrderId = orderId }));
app.MapPut("/refunds/v1", async (int orderId, RefundRepository refunds) => await refunds.Register(new Refund { OrderId = orderId }));
app.Run();
