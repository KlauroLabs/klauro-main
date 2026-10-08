namespace Shop.Web;

public class OrdersClient(HttpClient httpClient)
{
    public Task<string?> GetOrder(int id)
    {
        var uri = $"api/orders/{id}";
        return httpClient.GetFromJsonAsync<string>(uri);
    }

    public Task<string?> GetSummary()
    {
        var uri = "api/orders/summary";
        return httpClient.GetFromJsonAsync<string>(uri);
    }

    public Task<HttpResponseMessage> Place(string item)
    {
        return httpClient.PostAsJsonAsync("api/orders/", item);
    }
}
