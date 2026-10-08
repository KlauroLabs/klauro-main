using Shop.Sales.Data;
using Shop.Sales.Domain;

namespace Shop.Sales.Handlers;

public class RegisterShopperWhenSaleStarted(SalesContext context) : INotificationHandler<SaleStarted>
{
    public async Task Handle(SaleStarted started, CancellationToken cancellationToken)
    {
        context.Shoppers.Add(new Shopper { Name = started.Shopper });
        await context.SaveChangesAsync(cancellationToken);
    }
}
