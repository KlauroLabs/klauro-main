using Common.Domain;

Console.WriteLine("Billing worker starting...");

while (true)
{
    var invoice = InvoiceCalculator.ComputeNextBatch();
    Console.WriteLine($"Processed batch: {invoice}");
    await Task.Delay(TimeSpan.FromMinutes(5));
}
