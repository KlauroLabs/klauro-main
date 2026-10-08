namespace Shop.App.Views;

public partial class OrdersView : ContentPage
{
    public OrdersView(ViewModels.OrdersViewModel viewModel)
    {
        BindingContext = viewModel;
        InitializeComponent();
    }
}
