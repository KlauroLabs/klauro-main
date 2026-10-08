using Jobs.Workers;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddHostedService<RebuildIndexWorker>();
builder.Services.AddHostedService<SendDigestWorker>();
builder.Build().Run();
