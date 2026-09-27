public class LibraryClient(HttpClient httpClient)
{
    private readonly string remoteServiceBaseUrl = "/api/loans/";

    public Task Borrow(int bookId)
    {
        var message = new HttpRequestMessage(HttpMethod.Post, remoteServiceBaseUrl);
        return httpClient.SendAsync(message);
    }

    public Task<Loan?> Find(int id)
    {
        var uri = $"{remoteServiceBaseUrl}{id}";
        return httpClient.GetFromJsonAsync<Loan>(uri);
    }
}
