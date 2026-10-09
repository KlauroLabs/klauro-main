var builder = DistributedApplication.CreateBuilder(args);
var catalog = builder.AddProject("catalog");
builder.Build().Run();
