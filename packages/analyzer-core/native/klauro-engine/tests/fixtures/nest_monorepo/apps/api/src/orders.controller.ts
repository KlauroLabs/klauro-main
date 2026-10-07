import { Controller } from '@nestjs/common';
import { ApiPost } from '../../../libs/shared/src/api-post';
import { placeOrder } from '../../../libs/shared/src/orders';

@Controller('orders')
export class OrdersController {
  @ApiPost('place')
  place(): string {
    return placeOrder('book');
  }
}
