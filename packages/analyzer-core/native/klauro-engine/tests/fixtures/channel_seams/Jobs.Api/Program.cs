using Bus.Wrapper;
using Jobs.Contracts;

var app = WebApplication.CreateBuilder(args).Build();
app.MapPost("/index/rebuild", async (IPublisher publisher) =>
{
    var message = new GenericMessage { Owner = "all" };
    await publisher.SendMessage(Channels.RebuildIndex, message);
});
app.Run();
