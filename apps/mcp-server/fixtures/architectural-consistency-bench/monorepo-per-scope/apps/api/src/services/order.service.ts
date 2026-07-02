import { OrderRepository } from '../repositories/order.repository';
import { Order } from '../entities/order';
import { generateId, sanitizeId } from '../../../../packages/shared/src/id-utils';

export class OrderService {
  constructor(private repo: OrderRepository) {}

  getOrder(id: string): Order | undefined {
    return this.repo.findById(sanitizeId(id));
  }

  createOrder(order: Order): Order {
    return this.repo.save({ ...order, id: order.id || generateId('order') });
  }

  removeOrder(id: string): void {
    this.repo.delete(sanitizeId(id));
  }
}
