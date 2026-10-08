var app = WebApplication.CreateBuilder(args).Build();
var api = app.MapGroup("api/orders").WithTags("Orders").WithOpenApi();
api.MapGet("/{id:int}", (int id) => Results.Ok(id));
api.MapGet("/summary",
    [Produces("application/json")]
    () => Results.Ok("summary"));
api.MapPost("/", (string item) => Results.Created("/api/orders/1", item));
app.Run();
