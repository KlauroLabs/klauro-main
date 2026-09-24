namespace Shop.Web.Grpc;

public class BasketService : BasketApi.Basket.BasketBase
{
    public override Task<BasketResponse> GetBasket(GetBasketRequest request, ServerCallContext context)
    {
        return Task.FromResult(new BasketResponse());
    }

    private void Unrelated() {}
}
