namespace Networking;

public class AutoDiscoveryHost : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        await Announce(stopping);
    }

    private Task Announce(CancellationToken stopping) => Task.CompletedTask;
}
