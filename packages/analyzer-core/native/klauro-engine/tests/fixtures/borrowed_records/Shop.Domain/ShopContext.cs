namespace Shop.Domain;

public class Invoice
{
    public int Id { get; set; }
    public string Customer { get; set; }
    public decimal Total { get; set; }
}

public class ShopContext(DbContextOptions<ShopContext> options) : DbContext(options)
{
    public DbSet<Invoice> Invoices { get; set; }
}
