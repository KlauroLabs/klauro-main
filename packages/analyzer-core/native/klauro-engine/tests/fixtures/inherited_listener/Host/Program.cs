using Shop.Workers;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddHostedService<QueueHost<RefundWorker>>();
var host = builder.Build();
host.Run();

public class QueueHost<TWorker> : BackgroundService
{
    protected override Task ExecuteAsync(CancellationToken stoppingToken) => Task.CompletedTask;
}
