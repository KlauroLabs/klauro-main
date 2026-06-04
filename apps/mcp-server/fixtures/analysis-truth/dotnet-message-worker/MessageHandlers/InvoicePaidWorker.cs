using System.Threading;
using System.Threading.Tasks;

namespace Finance.Workers.MessageHandlers;

public abstract class BaseEventBusWorker<TEvent, TService> : IWorker
{
    public Task StartAsync(CancellationToken cancellationToken)
    {
        return HandleEvent(default!, cancellationToken);
    }

    public abstract Task<bool> HandleEvent(TEvent message, CancellationToken cancellationToken);
}

public interface IWorker
{
    Task StartAsync(CancellationToken cancellationToken);
}

public sealed class InvoicePaidWorker : BaseEventBusWorker<InvoicePaidMessage, InvoicePaidWorker>
{
    private readonly IMediator _mediator;

    public InvoicePaidWorker(IMediator mediator)
    {
        _mediator = mediator;
    }

    public override async Task<bool> HandleEvent(InvoicePaidMessage message, CancellationToken cancellationToken)
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
