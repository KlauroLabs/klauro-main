using MediatR;

public record IssueRefundCommand(int OrderId) : IRequest<bool>;

public class Refund
{
    public int Id { get; set; }
    public int OrderId { get; set; }
}

public class RefundRepository(ShopContext context)
{
    public async Task Register(Refund refund)
    {
        await context.Refunds.AddAsync(refund);
        await context.SaveChangesAsync();
    }

    public async Task<Refund?> Find(int orderId)
    {
        return await context.Refunds.FirstOrDefaultAsync(refund => refund.OrderId == orderId);
    }
}

public class IssueRefundCommandHandler(RefundRepository refunds) : IRequestHandler<IssueRefundCommand, bool>
{
    public async Task<bool> Handle(IssueRefundCommand command, CancellationToken cancellationToken)
    {
        var existing = await refunds.Find(command.OrderId);
        if (existing != null)
        {
            return false;
        }
        await refunds.Register(new Refund { OrderId = command.OrderId });
        return true;
    }
}

public class ShopContext : DbContext
{
    public DbSet<Refund> Refunds => Set<Refund>();
    public DbSet<QueuedRefund> QueuedRefunds => Set<QueuedRefund>();
    public DbSet<AuditRefund> AuditRefunds => Set<AuditRefund>();
}
