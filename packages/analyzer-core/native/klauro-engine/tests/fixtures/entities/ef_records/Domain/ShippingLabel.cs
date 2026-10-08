namespace Shop.Orders.Domain;

public class ShippingLabel
{
    public int Id { get; set; }
    public string Carrier { get; set; }
}

public class Tag
{
    public int Id { get; set; }
    public string Label { get; set; }
}
