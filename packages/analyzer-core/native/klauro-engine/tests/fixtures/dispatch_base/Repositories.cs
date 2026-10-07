public interface IRepository<T>
{
    Task Register(T item);
}

public class BaseRepository<T> : IRepository<T>
{
    public virtual async Task Register(T item)
    {
        await Store.Save(item);
    }
}

public class Pulse { }
public class Order { }
public class Refund { }

public interface IPulseRepository : IRepository<Pulse> { }

public class PulseRepository : BaseRepository<Pulse>, IPulseRepository { }

public class OrderRepository : BaseRepository<Order>
{
    public override async Task Register(Order item)
    {
        await Ledger.Charge(item);
        await base.Register(item);
    }
}

public class RefundRepository : BaseRepository<Refund>
{
    public override async Task Register(Refund item)
    {
        await Ledger.Credit(item);
        await base.Register(item);
    }
}

public abstract class Worker
{
    public Task Run() => Handle();
    public abstract Task Handle();
}

public class NightlyWorker : Worker
{
    public override async Task Handle() => await Ledger.Close();
}
