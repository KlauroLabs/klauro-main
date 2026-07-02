import { OrderService } from '../services/order.service';
import { Order } from '../entities/order';

export class InvoiceController {
  constructor(private service: OrderService) {}

  showInvoice(id: string): Order | undefined {
    return this.service.getOrder(id);
  }
}
