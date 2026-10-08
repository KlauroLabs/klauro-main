using Shop.Web;

var app = WebApplication.CreateBuilder(args).Build();
app.MapGet("/orders/{id}", async (int id, OrdersClient orders) => await orders.GetOrder(id));
app.MapGet("/orders/summary", async (OrdersClient orders) => await orders.GetSummary());
app.MapPost("/checkout", async (string item, OrdersClient orders) => await orders.Place(item));
app.MapGet("/cart/count", async (string shopper, CartClient cart) => await cart.Count(shopper));
app.MapGet("/orders/latest", async (LatestOrders orders) => await orders.Latest());
app.Run();
