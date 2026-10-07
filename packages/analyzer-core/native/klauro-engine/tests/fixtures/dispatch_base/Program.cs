var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapPost("/pulse", async (IPulseRepository pulses) => await pulses.Register(new Pulse()));
app.MapPost("/close", async (NightlyWorker worker) => await worker.Run());
app.Run();
