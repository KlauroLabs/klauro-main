namespace Api.Entities;

public static class StringExtensions
{
    public static string Slugify(this string value)
    {
        return value.Trim().ToLowerInvariant();
    }
}
