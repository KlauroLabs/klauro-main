using Shop.Sales.Data;
using Shop.Sales.Domain;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapPost("/sales", async (string shopper, decimal amount, SalesContext context) =>
{
    var sale = new Sale(shopper, amount);
    context.Sales.Add(sale);
    await context.SaveChangesAsync();
    return Results.Ok(sale.Id);
});
app.Run();
