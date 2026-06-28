using Microsoft.AspNetCore.Mvc;

namespace App.Controllers;

[ApiController]
[Route("users")]
public class UsersController : ControllerBase
{
    [HttpGet]
    public IActionResult List() => Ok();

    [HttpPost]
    public IActionResult Create() => Created("", null);

    [HttpDelete("{id}")]
    public IActionResult Remove(int id) => NoContent();
}
