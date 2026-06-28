using System.Threading.Tasks;
using Confluent.Kafka;

public class OrderService
{
    // PublishOrder produces to the orders topic.
    public async Task PublishOrder(IProducer<Null, string> producer)
    {
        await producer.ProduceAsync("orders", new Message<Null, string> { Value = "created" });
    }

    // ConsumeShipments consumes the shipments topic.
    public void ConsumeShipments(IConsumer<Null, string> consumer)
    {
        consumer.Subscribe("shipments");
    }
}
