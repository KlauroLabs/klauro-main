using Microsoft.EntityFrameworkCore;
using Ordering.Domain;

namespace Ordering.Infrastructure;

public class OrderingContext : DbContext
{
    public DbSet<Order> Orders { get; set; }

    public void Settle(Order order)
    {
        order.Pay();
    }
}
