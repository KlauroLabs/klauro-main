using System.Threading;
using System.Threading.Tasks;

public sealed class InvoicePaidWorker
{
    private readonly IMediator _mediator;

    public InvoicePaidWorker(IMediator mediator)
    {
        _mediator = mediator;
    }

    public async Task<bool> HandleEvent(InvoicePaidMessage message, CancellationToken cancellationToken)
    {
        await _mediator.Send(new CapturePaymentCommand(message.InvoiceId), cancellationToken);
        return true;
    }
}

public sealed record InvoicePaidMessage(string InvoiceId);
public sealed record CapturePaymentCommand(string InvoiceId);

public interface IMediator
{
    Task Send(object command, CancellationToken cancellationToken);
}
