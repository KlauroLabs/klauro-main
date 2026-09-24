using MediatR;

namespace Shop.Orders;

public record CreateOrderCommand(string Customer) : IRequest<bool>;

public record GetOrdersQuery(string Customer) : IRequest<string[]>;

public class CreateOrderCommandHandler : IRequestHandler<CreateOrderCommand, bool>
{
    public Task<bool> Handle(CreateOrderCommand request, CancellationToken cancellationToken)
    {
        return Task.FromResult(true);
    }
}

public class GetOrdersQueryHandler : IRequestHandler<GetOrdersQuery, string[]>
{
    public Task<string[]> Handle(GetOrdersQuery request, CancellationToken cancellationToken)
    {
        return Task.FromResult(new string[0]);
    }
}

public class OrdersEndpoint
{
    private readonly IMediator _mediator;

    public OrdersEndpoint(IMediator mediator)
    {
        _mediator = mediator;
    }

    public Task<bool> Create(string customer)
    {
        var command = new CreateOrderCommand(customer);
        return _mediator.Send(command);
    }

    public Task<string[]> List(string customer)
    {
        return _mediator.Send(new GetOrdersQuery(customer));
    }
}
