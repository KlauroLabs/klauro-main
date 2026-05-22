import { BadRequestException, Injectable } from '@nestjs/common';
import { CreateOrderDto } from './dto/create-order.dto';

@Injectable()
export class OrdersService {
  async create(body: unknown) {
    const parsed = CreateOrderDto.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('Invalid order');
    }
    return parsed.data;
  }
}
