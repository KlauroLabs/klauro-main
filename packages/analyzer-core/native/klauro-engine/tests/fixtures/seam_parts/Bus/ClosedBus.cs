namespace Shop.Bus;

public class ClosedBus : IEventBus
{
    public Task PublishAsync(IntegrationEvent @event)
    {
        throw new InvalidOperationException("The connection is not open.");
    }
}
