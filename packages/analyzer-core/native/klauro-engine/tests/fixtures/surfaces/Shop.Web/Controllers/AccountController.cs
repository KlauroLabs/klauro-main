using Microsoft.AspNetCore.Mvc;

namespace Shop.Web.Controllers;

public class AccountController : Controller
{
    [HttpGet]
    public IActionResult Login()
    {
        return View();
    }

    [HttpPost]
    public IActionResult Login(string user)
    {
        return Redirect("/");
    }

    public IActionResult Profile()
    {
        return View();
    }

    private string Helper()
    {
        return "";
    }
}
