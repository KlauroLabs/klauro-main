using Bus.Wrapper;
using Jobs.Contracts;

namespace Jobs.Workers;

public abstract class QueueWorker<TMessage> : BackgroundService
{
    protected abstract string Queue { get; }

    protected override Task ExecuteAsync(CancellationToken stopping)
    {
        Consumer.ListenToQueue<TMessage>(Queue, async message => await HandleEvent(message));
        return Task.CompletedTask;
    }

    public abstract Task<bool> HandleEvent(TMessage message);
}

public class RebuildIndexWorker : QueueWorker<GenericMessage>
{
    protected override string Queue => QueueName.Create("jobs.rebuild-index.v1");

    public override Task<bool> HandleEvent(GenericMessage message) => Task.FromResult(true);
}

public class SendDigestWorker : QueueWorker<GenericMessage>
{
    protected override string Queue => QueueName.Create("jobs.send-digest.v1");

    public override Task<bool> HandleEvent(GenericMessage message) => Task.FromResult(true);
}
