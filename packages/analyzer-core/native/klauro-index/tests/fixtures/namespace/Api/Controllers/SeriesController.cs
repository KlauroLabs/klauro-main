using Api.Entities;

namespace Api.Controllers;

public class SeriesController
{
    private readonly Catalogue _catalogue;

    public SeriesController(Catalogue catalogue)
    {
        _catalogue = catalogue;
    }

    public Series Read(string name)
    {
        return new Series { Name = name };
    }
}
