namespace Shop.Orders.Infrastructure;

public class AuditEntry
{
    public Guid EntryId { get; set; }
    public string Content { get; set; }
    public DateTime When { get; set; }
}

public static class AuditModel
{
    public static void UseAudit(this ModelBuilder builder)
    {
        builder.Entity<AuditEntry>(builder =>
        {
            builder.ToTable("audit_log");
            builder.HasKey(entry => entry.EntryId);
        });
    }
}
