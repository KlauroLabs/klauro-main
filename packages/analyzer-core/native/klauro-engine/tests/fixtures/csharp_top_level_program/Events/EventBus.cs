namespace Events;

public class EventBus
{
    public void Publish(string name)
    {
        System.Console.WriteLine(name);
    }
}
