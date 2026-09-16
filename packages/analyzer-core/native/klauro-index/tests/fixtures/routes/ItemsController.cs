namespace Api.Controllers;

[Route("[controller]")]
public class ItemsController
{
    [HttpGet("Entries")]
    public string GetEntries() => "";

    [HttpPost]
    public void Create() {}
}
