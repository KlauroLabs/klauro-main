namespace Shop.App.ViewModels;

public partial class OrdersViewModel(OrdersClient client)
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

    private void OnPropertyChanged(string name) { }
}

public class OrdersClient(HttpClient http)
{
    public async Task<string> LoadTitle() => await http.GetStringAsync("https://shop.example/orders/title");
    public async Task Cancel() => await http.PostAsync("https://shop.example/orders/cancel", null);
}
