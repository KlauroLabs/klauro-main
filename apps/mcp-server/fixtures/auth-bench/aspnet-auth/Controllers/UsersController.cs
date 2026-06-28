using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Authorization;

namespace App.Controllers;

[ApiController]
[Route("users")]
public class UsersController : ControllerBase
{
    [HttpGet]
    public IActionResult List() => Ok();

    [HttpPost]
    [Authorize]
    public IActionResult Create() => Created("", null);

    [HttpDelete("{id}")]
    [Authorize(Roles = "Admin")]
    public IActionResult Remove(int id) => NoContent();
}
