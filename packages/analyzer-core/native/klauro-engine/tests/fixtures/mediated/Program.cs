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
app.Run();
