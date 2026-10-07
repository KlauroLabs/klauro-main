namespace Shop.Bus;

public record IntegrationEvent;

public interface IIntegrationEventHandler<in T> where T : IntegrationEvent
{
    Task Handle(T @event);
}

public interface IEventBus
{
    Task PublishAsync(IntegrationEvent @event);
}

public interface IEventBusBuilder
{
    IEventBusBuilder AddSubscription<T, TH>() where T : IntegrationEvent where TH : IIntegrationEventHandler<T>;
}

public record OrderPaid(int OrderId) : IntegrationEvent;
