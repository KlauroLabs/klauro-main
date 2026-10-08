public class Archive
{
    public async Task<string> StoreSnapshot(int orderId)
    {
        var path = $"/var/archive/{orderId}.json";
        var previous = await File.ReadAllTextAsync(path);
        await File.WriteAllTextAsync(path + ".bak", previous);
        await File.WriteAllTextAsync(path, "{}");
        return path;
    }

    public static string DispatchTargetFor(int orderId) => orderId % 2 == 0 ? "even" : "odd";

    public static void ThrowNotFound() => throw new KeyNotFoundException("No such order.");
}
