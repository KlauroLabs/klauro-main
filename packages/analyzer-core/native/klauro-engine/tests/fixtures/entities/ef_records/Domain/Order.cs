namespace Shop.Orders.Domain;

public enum OrderState
{
    Placed,
    Shipped,
}

public class Order
{
    public int Id { get; set; }
    public string BuyerId { get; set; }
    public OrderState State { get; set; }
    public decimal Total { get; set; }
}
