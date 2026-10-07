namespace Shop.Worker;

public class Pump<TWorker> : BackgroundService where TWorker : IOrders, new()
{
    private readonly TWorker _worker = new();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await _worker.Confirm();
    }
}
