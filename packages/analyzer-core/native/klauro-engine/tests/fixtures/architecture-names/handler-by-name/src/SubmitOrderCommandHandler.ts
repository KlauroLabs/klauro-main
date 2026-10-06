import type { Order } from './Order';

export class SubmitOrderCommandHandler {
  async handle(order: Order): Promise<Order> {
    return order;
  }
}
