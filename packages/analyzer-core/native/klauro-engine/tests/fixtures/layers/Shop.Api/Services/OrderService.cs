using Shop.Api.Data;

namespace Shop.Api.Services;

public interface IOrderService
{
    Task<List<Order>> ListAsync();
}

public class OrderService : IOrderService
{
    private readonly OrderRepository _repository;

    public OrderService(OrderRepository repository)
    {
        _repository = repository;
    }

    public Task<List<Order>> ListAsync()
    {
        return _repository.AllAsync();
    }
}
