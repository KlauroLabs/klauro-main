using Microsoft.AspNetCore.Mvc;
using Shop.Api.Services;

namespace Shop.Api.Controllers;

[ApiController]
[Route("api/orders")]
public class OrdersController : ControllerBase
{
    private readonly IOrderService _orders;

    public OrdersController(IOrderService orders)
    {
        _orders = orders;
    }

    [HttpGet]
    public async Task<IActionResult> List()
    {
        return Ok(await _orders.ListAsync());
    }
}
