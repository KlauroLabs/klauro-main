using GrpcCartClient = Shop.Cart.Grpc.Cart.CartClient;

namespace Shop.Web;

public class CartClient(GrpcCartClient cart)
{
    public async Task<int> Count(string shopper)
    {
        var response = await cart.GetCartAsync(new Shop.Cart.Grpc.GetCartRequest { Shopper = shopper });
        return response.Lines;
    }
}
