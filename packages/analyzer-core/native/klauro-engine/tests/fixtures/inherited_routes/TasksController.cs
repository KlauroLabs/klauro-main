using Microsoft.AspNetCore.Mvc;

namespace Shop.Api;

public class TasksController : BaseApiController
{
    [HttpGet("{taskId}")]
    public IActionResult GetTask(string taskId)
    {
        return Ok(taskId);
    }

    [HttpPost("[action]")]
    public IActionResult Start()
    {
        return Ok();
    }
}
