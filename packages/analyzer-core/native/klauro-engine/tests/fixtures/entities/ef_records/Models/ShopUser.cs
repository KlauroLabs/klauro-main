namespace Shop.Orders.Models;

public class ShopUser : IdentityUser
{
    public string DisplayName { get; set; }
    public string Street { get; set; }
}
