namespace Shop.Web.Apis;

public static class HooksApi
{
    public static RouteGroupBuilder MapHooks(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("api/hooks");
        api.MapGet("/", async (HooksContext context) => await context.Hooks.ToListAsync());
        api.MapPost("/received", async (HookData hook, HooksRepository repository) =>
        {
            await repository.AddNew(hook);
        });
        return api;
    }
}

public class HookData
{
}
