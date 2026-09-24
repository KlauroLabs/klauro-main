namespace Shop.Worker;

public class GracePeriod(IOrders orders) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await orders.Confirm();
    }
}
