using Shop.Orders.Domain;

namespace Shop.Orders.Infrastructure;

public class OrderConfiguration : IEntityTypeConfiguration<Order>
{
    public void Configure(EntityTypeBuilder<Order> orders)
    {
        orders.ToTable("purchases");
        orders.HasKey(order => order.Id);
    }
}

public class OrdersContext(DbContextOptions<OrdersContext> options) : IdentityDbContext<ShopUser>(options)
{
    public DbSet<Order> Orders { get; set; }

    protected override void OnModelCreating(ModelBuilder builder)
    {
        builder.ApplyConfiguration(new OrderConfiguration());
        builder.UseAudit();
    }
}
