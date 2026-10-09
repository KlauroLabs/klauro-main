namespace Archive;

public class Statements
{
    public string Fetch(string account)
    {
        return System.IO.File.ReadAllText(account);
    }

    private string Hidden()
    {
        return string.Empty;
    }
}
