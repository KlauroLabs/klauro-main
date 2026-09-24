namespace Ordering.Domain;

public class Order
{
    public int Id { get; set; }
    public decimal Total { get; set; }

    public void Pay() { }
}
