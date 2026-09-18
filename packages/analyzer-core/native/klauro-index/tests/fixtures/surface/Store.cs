using System.IO;

namespace Demo;

public class Store
{
    public byte[] Load(string path)
    {
        return File.ReadAllBytes(path);
    }

    public string Name(string path)
    {
        return Path.GetFileName(path);
    }
}
