using Bus.Wrapper;

namespace Jobs.Contracts;

public class GenericMessage
{
    public string Owner { get; set; }
}

public static class Channels
{
    public static Exchange RebuildIndex => Exchange.Create("jobs", "rebuild-index");
    public static Exchange SendDigest => Exchange.Create("jobs", "send-digest");
}
