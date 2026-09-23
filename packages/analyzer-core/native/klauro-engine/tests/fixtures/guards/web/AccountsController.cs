using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("accounts")]
[Authorize]
public class AccountsController : ControllerBase
{
    [HttpGet]
    public IActionResult List() => Ok();

    [HttpPost("register")]
    [AllowAnonymous]
    public IActionResult Register() => Ok();

    [HttpDelete("{id}")]
    [Authorize(Roles = "Admin")]
    public IActionResult Remove(int id) => Ok();
}
