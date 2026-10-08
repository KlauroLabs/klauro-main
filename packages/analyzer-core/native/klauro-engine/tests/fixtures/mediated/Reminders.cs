public class Reminders(ILogger<Reminders> logger)
{
    private readonly List<Func<int, Task>> _listeners = new();

    public async Task NotifyCustomerAsync(int orderId)
    {
        logger.LogInformation("Reminding {Order}", orderId);
        foreach (var listener in _listeners)
        {
            await listener(orderId);
        }
    }
}
