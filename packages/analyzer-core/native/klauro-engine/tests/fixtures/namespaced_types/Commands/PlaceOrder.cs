namespace Shop.Commands;

using Shop.Domain;

public class PlaceOrder
{
    public Order Handle(string buyer)
    {
        var order = new Order(buyer, 3);
        return order;
    }
}
