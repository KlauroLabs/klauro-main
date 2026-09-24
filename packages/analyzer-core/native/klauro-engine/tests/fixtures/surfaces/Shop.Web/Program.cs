var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapDefaultControllerRoute();
app.MapGrpcService<Shop.Web.Grpc.BasketService>();
app.Run();
