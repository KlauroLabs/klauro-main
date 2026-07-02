var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();

var app = builder.Build();

app.MapGet("/health", () => Results.Ok("healthy"));
app.MapControllers();

app.Run();
