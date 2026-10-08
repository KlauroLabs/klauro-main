namespace Shop.Sales.Domain;

public abstract class Aggregate
{
    private readonly List<INotification> _events = [];

    public IReadOnlyCollection<INotification> Events => _events;

    protected void Raise(INotification raised) => _events.Add(raised);
}

public class Sale : Aggregate
{
    public Sale(string shopper, decimal amount)
    {
        Shopper = shopper;
        Amount = amount;
        Raise(new SaleStarted(shopper));
    }

    public int Id { get; private set; }
    public string Shopper { get; private set; }
    public decimal Amount { get; private set; }
}

public record SaleStarted(string Shopper) : INotification;

public class Shopper
{
    public int Id { get; set; }
    public string Name { get; set; }
}
