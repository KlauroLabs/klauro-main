namespace Shop.App.ViewModels;

public partial class OrdersViewModel(OrdersClient client, INavigationService navigation)
{
    public string Title { get; set; } = "";

    public async Task InitializeAsync()
    {
        Title = await client.LoadTitle();
        OnPropertyChanged(nameof(Title));
    }

    [RelayCommand]
    private async Task CancelOrderAsync()
    {
        await client.Cancel();
    }

    [RelayCommand]
    private async Task Refresh()
    {
        await InitializeAsync();
    }

    [RelayCommand]
    private async Task CheckoutAsync()
    {
        var http = CreateClient();
        await http.PostAsync("https://shop.example/orders/checkout", null);
        await navigation.NavigateToAsync("//Main/Orders");
    }

    private HttpClient CreateClient() => new HttpClient();

    private void OnPropertyChanged(string name) { }
}

public class OrdersClient(HttpClient http)
{
    public async Task<string> LoadTitle() => await http.GetStringAsync("https://shop.example/orders/title");
    public async Task Cancel() => await http.PostAsync("https://shop.example/orders/cancel", null);
}

public interface INavigationService
{
    Task NavigateToAsync(string route);
}
