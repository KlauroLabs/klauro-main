namespace Shop.Bus;

public class Outbox(IEventBus bus)
{
    private readonly List<IntegrationEvent> _pending = new();

    public async Task SaveAndPublish(IntegrationEvent @event)
    {
        _pending.Add(@event);
        Mark(@event);
        await bus.PublishAsync(@event);
        _pending.Remove(@event);
    }

    private void Mark(IntegrationEvent @event)
    {
        _pending.Sort((left, right) => 0);
    }
}
