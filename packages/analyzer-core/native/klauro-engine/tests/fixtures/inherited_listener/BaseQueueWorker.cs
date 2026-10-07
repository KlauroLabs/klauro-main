namespace Shop.Workers;

public abstract class BaseQueueWorker<TMessage>
{
    private readonly IConsumer _consumer;

    protected BaseQueueWorker(IConsumer consumer)
    {
        _consumer = consumer;
    }

    protected abstract string Queue { get; }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _consumer.ListenToQueue<TMessage>(Queue, async message => await HandleEvent(message, cancellationToken));
        return Task.CompletedTask;
    }

    public abstract Task<bool> HandleEvent(TMessage message, CancellationToken cancellationToken);
}
