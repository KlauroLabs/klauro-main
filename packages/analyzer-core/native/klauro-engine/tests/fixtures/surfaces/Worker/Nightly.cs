using Quartz;

namespace Shop.Worker;

public class NightlyReport(IOrders orders) : IJob
{
    public async Task Execute(IJobExecutionContext context)
    {
        await orders.Confirm();
    }
}
