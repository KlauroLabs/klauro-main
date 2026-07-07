using Microsoft.EntityFrameworkCore;
using App.Services;
using App.Data;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddScoped<IUserService, UserService>();
builder.Services.AddDbContext<AppDbContext>(o => o.UseSqlite("Data Source=app.db"));
builder.Services.AddControllers();
var app = builder.Build();
app.MapControllers();
app.Run();
