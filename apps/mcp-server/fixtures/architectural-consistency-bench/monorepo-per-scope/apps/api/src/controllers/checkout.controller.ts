import { OrderService } from '../services/order.service';
import { Order } from '../entities/order';

export class CheckoutController {
  constructor(private service: OrderService) {}

  submitOrder(order: Order): Order {
    return this.service.createOrder(order);
  }
}
