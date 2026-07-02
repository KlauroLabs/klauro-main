namespace Common.Domain;

public static class InvoiceCalculator
{
    public static string ComputeNextBatch()
    {
        return $"batch-{DateTime.UtcNow:yyyyMMddHHmmss}";
    }
}
