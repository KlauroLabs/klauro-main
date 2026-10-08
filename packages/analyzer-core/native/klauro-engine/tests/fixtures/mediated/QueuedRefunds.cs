public class QueuedRefund
{
    public int Id { get; set; }
}

public class AuditRefund
{
    public int Id { get; set; }
}

public class QueuedRefundRepository(ShopContext context)
{
    public async Task<List<QueuedRefund>> GetAll()
    {
        return await context.QueuedRefunds.ToListAsync();
    }
}

public class AuditRefundRepository(ShopContext context)
{
    public async Task<List<AuditRefund>> GetAll()
    {
        return await context.AuditRefunds.ToListAsync();
    }
}
