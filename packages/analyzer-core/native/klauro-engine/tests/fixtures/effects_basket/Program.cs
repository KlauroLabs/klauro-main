var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapDelete("/basket/{id}", async (string id, BasketRepository baskets) => await baskets.DeleteBasketAsync(id));
app.MapGet("/basket/{id}", async (string id, BasketRepository baskets) => await baskets.GetBasketAsync(id));
app.MapPut("/basket/{id}", async (string id, string basket, BasketRepository baskets) => await baskets.UpdateBasketAsync(id, basket));
app.MapGet("/orders/count/{buyer}", async (int buyer, OrdersQuery orders) => await orders.CountAsync(buyer));
app.Run();
