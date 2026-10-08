using System.Text.Json;
using Cart.Api.Model;
using StackExchange.Redis;

namespace Cart.Api.Repositories;

public class RedisCartRepository(IConnectionMultiplexer redis) : ICartRepository
{
    private readonly IDatabase _database = redis.GetDatabase();

    private static RedisKey KeyOf(string shopperId) => "/cart/" + shopperId;

    public async Task<bool> DeleteCartAsync(string id)
    {
        return await _database.KeyDeleteAsync(KeyOf(id));
    }

    public async Task<CustomerCart> GetCartAsync(string shopperId)
    {
        using var data = await _database.StringGetLeaseAsync(KeyOf(shopperId));
        if (data is null || data.Length == 0)
        {
            return null;
        }
        return JsonSerializer.Deserialize(data.Span, CartSerializationContext.Default.CustomerCart);
    }

    public async Task<CustomerCart> UpdateCartAsync(CustomerCart cart)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(cart, CartSerializationContext.Default.CustomerCart);
        var created = await _database.StringSetAsync(KeyOf(cart.ShopperId), json);
        if (!created)
        {
            return null;
        }
        return await GetCartAsync(cart.ShopperId);
    }
}

public interface ICartRepository
{
    Task<CustomerCart> GetCartAsync(string shopperId);
    Task<CustomerCart> UpdateCartAsync(CustomerCart cart);
    Task<bool> DeleteCartAsync(string id);
}
