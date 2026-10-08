namespace Shop.Orders.Migrations;

public partial class Labels : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "printed_label",
            columns: table => new
            {
                Id = table.Column<int>(nullable: false),
                Carrier = table.Column<string>(nullable: true),
                TrackingCode = table.Column<string>(nullable: true)
            });
        migrationBuilder.CreateTable(
            name: "scratch_notes",
            columns: table => new
            {
                Id = table.Column<int>(nullable: false),
                Body = table.Column<string>(nullable: true)
            });
        migrationBuilder.CreateTable(
            name: "tags",
            columns: table => new
            {
                Id = table.Column<int>(nullable: false),
                Label = table.Column<string>(nullable: true)
            });
        migrationBuilder.CreateTable(
            name: "order_tag",
            columns: table => new
            {
                orders_id = table.Column<int>(nullable: false),
                tags_id = table.Column<int>(nullable: false)
            });
        migrationBuilder.RenameTable(
            name: "printed_label",
            newName: "printed_labels");
        migrationBuilder.Sql("DROP TABLE IF EXISTS scratch_notes;");
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
    }
}
