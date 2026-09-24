using Microsoft.EntityFrameworkCore.Migrations;

public partial class Initial : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "CatalogBrands",
            columns: table => new
            {
                Id = table.Column<int>(nullable: false),
                Brand = table.Column<string>(maxLength: 100, nullable: false)
            });
    }
}
