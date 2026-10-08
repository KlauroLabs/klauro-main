namespace Cart.Api.Model;

public class CustomerCart
{
    public string ShopperId { get; set; }
    public List<CartLine> Lines { get; set; } = [];
}
