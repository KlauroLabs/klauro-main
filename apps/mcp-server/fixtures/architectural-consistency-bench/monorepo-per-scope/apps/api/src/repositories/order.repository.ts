import { Order } from '../entities/order';

export class OrderRepository {
  private orders: Order[] = [];

  findById(id: string): Order | undefined {
    return this.orders.find(o => o.id === id);
  }

  save(order: Order): Order {
    this.orders.push(order);
    return order;
  }

  delete(id: string): void {
    this.orders = this.orders.filter(o => o.id !== id);
  }
}
