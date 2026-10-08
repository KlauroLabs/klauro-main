namespace Shop.Reports;

public class Closing
{
    private Shop.Domain.Order Current { get; set; }

    public void Finish()
    {
        Current.Close();
    }
}
