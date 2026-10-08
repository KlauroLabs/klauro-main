using Shop.Domain;

var app = WebApplication.CreateBuilder(args).Build();
app.MapGet("/reports/invoices", (ShopContext context) => context.Invoices.Where(invoice => invoice.Total > 100).ToList());
app.Run();
