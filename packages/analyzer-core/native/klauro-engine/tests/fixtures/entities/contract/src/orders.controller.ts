import { Body, Controller, Post, Get } from '@nestjs/common';

export class CreateOrderDto {
  sku: string;
  quantity: number;
}

export interface OrderView {
  id: string;
  sku: string;
  quantity: number;
}

export interface Pagination {
  page: number;
  size: number;
}

@Controller('orders')
export class OrdersController {
  @Post()
  create(@Body() dto: CreateOrderDto): Promise<OrderView> {
    return Promise.resolve({ id: '1', sku: dto.sku, quantity: dto.quantity });
  }

  @Get()
  list(): OrderView[] {
    return [];
  }
}

export function paginate(items: string[], window: Pagination): string[] {
  return items.slice(window.page * window.size, window.size);
}
