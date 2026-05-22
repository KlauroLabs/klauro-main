import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class AppLoggerService {
  private readonly logger = new Logger(AppLoggerService.name);

  info(message: string, context?: Record<string, unknown>): void {
    this.logger.log({ message, context });
  }
}
