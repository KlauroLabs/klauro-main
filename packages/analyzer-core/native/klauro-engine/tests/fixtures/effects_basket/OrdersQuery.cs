using Npgsql;

public class OrdersQuery(NpgsqlDataSource dataSource)
{
    public async Task<int> CountAsync(int buyer)
    {
        await using var connection = await dataSource.OpenConnectionAsync();
        await using var command = new NpgsqlCommand("SELECT count(*) FROM orders WHERE buyer = @buyer", connection);
        command.Parameters.AddWithValue("buyer", buyer);
        return (int)(await command.ExecuteScalarAsync())!;
    }
}
