using Shop.Cart.Grpc;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddGrpc();
var app = builder.Build();
app.MapGrpcService<CartService>();
app.Run();
