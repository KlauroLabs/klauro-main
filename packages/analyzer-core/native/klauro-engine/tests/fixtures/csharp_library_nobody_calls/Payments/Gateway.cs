namespace Payments;

public class Gateway
{
    public void Charge(int amount)
    {
        System.Console.WriteLine(amount);
    }

    public void Refund(int amount)
    {
        System.Console.WriteLine(amount);
    }
}
