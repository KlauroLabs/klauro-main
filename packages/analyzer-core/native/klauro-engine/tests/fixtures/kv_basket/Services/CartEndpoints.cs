using Cart.Api.Model;
using Cart.Api.Repositories;

namespace Cart.Api.Services;

public static class CartEndpoints
{
    public static void MapCart(this WebApplication app)
    {
        app.MapGet("/cart/{id}", async (string id, ICartRepository repository) => await repository.GetCartAsync(id));
        app.MapPut("/cart", async (CustomerCart cart, ICartRepository repository) => await repository.UpdateCartAsync(cart));
        app.MapDelete("/cart/{id}", async (string id, ICartRepository repository) => await repository.DeleteCartAsync(id));
        app.MapPost("/notices", (ReceivedNotice notice, NoticeBoard board) => board.Show(notice));
    }
}

public class NoticeBoard
{
    private readonly List<ReceivedNotice> _shown = [];

    public void Show(ReceivedNotice notice) => _shown.Add(notice);
}
