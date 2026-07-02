import { OrderRepository } from '../repositories/order.repository';
import { Order } from '../entities/order';

// PLANTED VIOLATION: within apps/api, every other controller goes through
// OrderService — this one reaches OrderRepository directly, skipping the
// service layer that is this scope's own local norm.
export class AdminOrderController {
  constructor(private repo: OrderRepository) {}

  forceDeleteOrder(id: string): void {
    this.repo.delete(id);
  }

  forceGetOrder(id: string): Order | undefined {
    return this.repo.findById(id);
  }
}
