using Shop.Domain;

var app = WebApplication.CreateBuilder(args).Build();
app.MapPost("/invoices", async (string customer, decimal total, ShopContext context) =>
{
    context.Invoices.Add(new Invoice { Customer = customer, Total = total });
    await context.SaveChangesAsync();
});
app.Run();
