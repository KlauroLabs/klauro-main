namespace Shop.Workers;

public record RefundRequested(int OrderId);
public record InvoiceDue(int InvoiceId);

public class RefundWorker(IConsumer consumer, IRefunds refunds) : BaseQueueWorker<RefundRequested>(consumer)
{
    protected override string Queue => "shop.refunds.v1";

    public override async Task<bool> HandleEvent(RefundRequested message, CancellationToken cancellationToken)
    {
        await refunds.Issue(message.OrderId);
        return true;
    }
}

public class InvoiceWorker(IConsumer consumer, IInvoices invoices) : BaseQueueWorker<InvoiceDue>(consumer)
{
    protected override string Queue => "shop.invoices.v1";

    public override async Task<bool> HandleEvent(InvoiceDue message, CancellationToken cancellationToken)
    {
        await invoices.Send(message.InvoiceId);
        return true;
    }
}
