import { OrderService } from '../services/order.service';

export class FulfillmentController {
  constructor(private service: OrderService) {}

  cancelOrder(id: string): void {
    this.service.removeOrder(id);
  }
}
