using Networking;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddHostedService<AutoDiscoveryHost>();
var app = builder.Build();
app.Run();
