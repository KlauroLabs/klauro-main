using Cart.Api.Repositories;
using Cart.Api.Services;
using Cart.Api.Preview;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<ICartRepository, RedisCartRepository>();
builder.Services.AddSingleton<NoticeBoard>();
var app = builder.Build();
app.MapCart();
app.MapPreview();
app.Run();
