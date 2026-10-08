namespace Shop.Commands;

using Shop.Queries;

public class RefundOrder
{
    public Order Handle(string buyer)
    {
        return new Order { Buyer = buyer };
    }
}
