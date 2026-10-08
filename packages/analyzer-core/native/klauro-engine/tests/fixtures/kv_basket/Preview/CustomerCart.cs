namespace Cart.Api.Preview;

public class CustomerCart
{
    public string Title { get; set; }
    public int Count { get; set; }
}

public static class PreviewEndpoints
{
    public static void MapPreview(this WebApplication app)
    {
        app.MapGet("/preview", () => new CustomerCart { Title = "Your cart", Count = 0 });
    }
}
