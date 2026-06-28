namespace Shop
{
    public class Service
    {
        void Persist(Account a)
        {
            a.Save();
        }
    }
}
