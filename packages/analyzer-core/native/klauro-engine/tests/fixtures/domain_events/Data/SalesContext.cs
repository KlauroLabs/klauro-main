using Shop.Sales.Domain;

namespace Shop.Sales.Data;

public class SalesContext(DbContextOptions<SalesContext> options) : DbContext(options)
{
    public DbSet<Sale> Sales { get; set; }
    public DbSet<Shopper> Shoppers { get; set; }
}
