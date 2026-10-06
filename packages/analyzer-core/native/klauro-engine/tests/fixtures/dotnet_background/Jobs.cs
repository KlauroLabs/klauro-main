using System.Threading;
using System.Threading.Tasks;

namespace Shop.Jobs;

public interface IScheduledTask
{
    Task ExecuteAsync(CancellationToken token);
}

public class CleanupTask : IScheduledTask
{
    public Task ExecuteAsync(CancellationToken token)
    {
        return Task.CompletedTask;
    }

    public void Describe()
    {
    }
}

public class PollingWorker : BackgroundService
{
    protected override Task ExecuteAsync(CancellationToken token)
    {
        return Task.CompletedTask;
    }
}
