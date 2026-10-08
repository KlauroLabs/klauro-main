namespace Shop.Web;

public interface IRequestProvider
{
    Task<TResult?> GetAsync<TResult>(string uri);
}

public class RequestProvider(HttpClient http) : IRequestProvider
{
    public async Task<TResult?> GetAsync<TResult>(string uri)
    {
        using var response = await http.GetAsync(uri);
        return await response.Content.ReadFromJsonAsync<TResult>();
    }
}

public class LatestOrders(IRequestProvider provider, Settings settings)
{
    private const string ApiUrlBase = "api/orders";

    public Task<string?> Latest()
    {
        var uri = UriHelper.CombineUri(settings.OrdersBase, $"{ApiUrlBase}/latest");
        return provider.GetAsync<string>(uri);
    }
}
