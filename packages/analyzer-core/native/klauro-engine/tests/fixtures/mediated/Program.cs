using MediatR;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapPost("/refunds/{orderId}", async (int orderId, IMediator mediator) => await mediator.Send(new IssueRefundCommand(orderId)));
app.MapPost("/refunds/{orderId}/remind", async (int orderId, Reminders reminders) => await reminders.NotifyCustomerAsync(orderId));
app.Run();
