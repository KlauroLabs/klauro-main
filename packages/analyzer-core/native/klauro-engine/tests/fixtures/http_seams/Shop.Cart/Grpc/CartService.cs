namespace Shop.Cart.Grpc;

public class CartService : Cart.CartBase
{
    public override Task<CartResponse> GetCart(GetCartRequest request, ServerCallContext context)
    {
        return Task.FromResult(new CartResponse { Lines = 0 });
    }
}
