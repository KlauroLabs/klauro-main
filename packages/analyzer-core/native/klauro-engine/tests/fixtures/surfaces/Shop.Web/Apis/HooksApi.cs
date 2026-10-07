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
        api.MapPut("/", async Task<Results<Created, BadRequest<string>>> (HookData hook, HooksRepository repository) =>
        {
            await repository.AddNew(Links.Url(hook));
            return TypedResults.Created("/api/hooks/1");
        });
        return api;
    }
}

public class HookData
{
}

public static class Links
{
    public static HookData Url(HookData hook) => hook;
}
