using Api.Entities;

namespace Api.Controllers;

public class SeriesController
{
    public Series Read(string name)
    {
        return new Series { Name = name };
    }
}
