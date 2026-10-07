namespace Shop.Worker;

public class Reminders(IOrders orders) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await orders.Confirm();
            await Task.Delay(TimeSpan.FromMinutes(5), stoppingToken);
        }
    }
}
