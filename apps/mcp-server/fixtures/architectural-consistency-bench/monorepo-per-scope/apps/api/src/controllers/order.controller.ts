import { OrderService } from '../services/order.service';
import { Order } from '../entities/order';

export class OrderController {
  constructor(private service: OrderService) {}

  getOrder(id: string): Order | undefined {
    return this.service.getOrder(id);
  }

  createOrder(order: Order): Order {
    return this.service.createOrder(order);
  }
}
