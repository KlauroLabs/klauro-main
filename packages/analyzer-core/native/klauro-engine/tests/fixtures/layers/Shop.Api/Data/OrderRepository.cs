using Microsoft.EntityFrameworkCore;
using Npgsql.EntityFrameworkCore.PostgreSQL;

namespace Shop.Api.Data;

public class Order
{
    public int Id { get; set; }
}

public class ShopContext : DbContext
{
    public DbSet<Order> Orders { get; set; }
}

public class OrderRepository
{
    private readonly ShopContext _context;

    public OrderRepository(ShopContext context)
    {
        _context = context;
    }

    public Task<List<Order>> AllAsync()
    {
        return _context.Orders.ToListAsync();
    }
}
