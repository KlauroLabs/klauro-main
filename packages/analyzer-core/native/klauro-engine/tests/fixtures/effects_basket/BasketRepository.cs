using StackExchange.Redis;

public class BasketRepository(IConnectionMultiplexer redis)
{
    private readonly IDatabase _database = redis.GetDatabase();

    public async Task<bool> DeleteBasketAsync(string id)
    {
        return await _database.KeyDeleteAsync(id);
    }

    public async Task<string?> GetBasketAsync(string id)
    {
        return await _database.StringGetAsync(id);
    }

    public async Task UpdateBasketAsync(string id, string basket)
    {
        await _database.StringSetAsync(id, basket);
    }
}
