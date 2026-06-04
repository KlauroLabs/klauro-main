import { Controller, Injectable } from '@nestjs/common';
import { EventPattern, MessagePattern } from '@nestjs/microservices';
import { OnEvent } from '@nestjs/event-emitter';

@Injectable()
@Controller()
export class BillingEvents {
  @OnEvent('invoice.paid')
  handleInvoicePaid(event: { invoiceId: string }) {
    return event.invoiceId;
  }

  @MessagePattern('user.created')
  handleUserCreated(event: { userId: string }) {
    return event.userId;
  }

  @EventPattern('account.closed')
  handleAccountClosed(event: { accountId: string }) {
    return event.accountId;
  }
}
