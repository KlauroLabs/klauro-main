using System.Collections.Generic;
using Microsoft.EntityFrameworkCore;

namespace App;

public class User
{
    public int Id { get; set; }
    public List<Order> Orders { get; set; }
}

public class Order
{
    public int Id { get; set; }
    public User User { get; set; }
}

public class AppDbContext : DbContext
{
    public DbSet<User> Users { get; set; }
    public DbSet<Order> Orders { get; set; }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<User>().HasMany(u => u.Orders).WithOne(o => o.User);
    }
}
