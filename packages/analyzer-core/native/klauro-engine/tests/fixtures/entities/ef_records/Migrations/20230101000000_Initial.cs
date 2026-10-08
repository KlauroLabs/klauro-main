namespace Shop.Orders.Migrations;

public partial class Initial : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "purchases",
            columns: table => new
            {
                Id = table.Column<int>(nullable: false),
                BuyerId = table.Column<string>(nullable: true),
                Total = table.Column<decimal>(nullable: false)
            });
        migrationBuilder.CreateTable(
            name: "orderstate",
            columns: table => new
            {
                Id = table.Column<int>(nullable: false),
                Name = table.Column<string>(nullable: false)
            });
        migrationBuilder.CreateTable(
            name: "AspNetUsers",
            columns: table => new
            {
                Id = table.Column<string>(nullable: false),
                UserName = table.Column<string>(nullable: true),
                Email = table.Column<string>(nullable: true)
            });
        migrationBuilder.CreateTable(
            name: "AspNetRoles",
            columns: table => new
            {
                Id = table.Column<string>(nullable: false),
                Name = table.Column<string>(nullable: true)
            });
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(name: "purchases");
        migrationBuilder.DropTable(name: "orderstate");
        migrationBuilder.DropTable(name: "AspNetUsers");
        migrationBuilder.DropTable(name: "AspNetRoles");
    }
}
