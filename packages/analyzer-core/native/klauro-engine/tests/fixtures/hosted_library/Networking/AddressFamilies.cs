namespace Networking;

public static class AddressFamilies
{
    public static bool PrefersIpv6(string address) => address.Contains(':');

    public static string Describe(string address) => PrefersIpv6(address) ? "IPv6" : "IPv4";
}
