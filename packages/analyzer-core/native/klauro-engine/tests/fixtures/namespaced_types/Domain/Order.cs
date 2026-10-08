namespace Shop.Domain;

public class Order
{
    protected Order() { }

    public Order(string buyer, int total, int? discount = null) : this()
    {
        Buyer = buyer;
        Total = total;
    }

    public string Buyer { get; private set; }
    public int Total { get; private set; }
}
