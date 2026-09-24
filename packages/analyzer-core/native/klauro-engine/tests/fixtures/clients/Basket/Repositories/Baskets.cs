namespace Shop.Basket.Repositories;

public class Baskets(IConnectionMultiplexer redis)
{
    private readonly IDatabase _database = redis.GetDatabase();

    public async Task<bool> Forget(string id)
    {
        return await _database.KeyDeleteAsync(id);
    }
}
