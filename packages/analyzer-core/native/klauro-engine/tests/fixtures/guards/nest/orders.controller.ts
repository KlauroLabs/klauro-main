import { Controller, Get, Post, UseGuards } from '@nestjs/common';

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  @Get()
  list() {
    return [];
  }

  @Post('webhook')
  @Public()
  receive() {
    return {};
  }
}

@Controller('session')
export class SessionController {
  @Post('login')
  @Authenticated({ public: true })
  login(credential: LoginCredentialDto) {
    return {};
  }
}
