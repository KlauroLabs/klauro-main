import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { placeOrder } from '../../../libs/shared/src/orders';

@Injectable()
export class RestockScheduler {
  @Cron('0 * * * *')
  restock(): void {
    placeOrder('restock');
  }
}
