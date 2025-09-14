import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request, Response } from 'express';

@Injectable()
export class RequestLoggerInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RequestLoggerInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    
    const { method, url, headers, body } = request;
    const userAgent = headers['user-agent'] || '';
    const start = Date.now();
    
    // Generate request ID if not present
    const requestId = headers['x-request-id'] || Math.random().toString(36).substring(7);
    request.headers['x-request-id'] = requestId;
    response.setHeader('X-Request-ID', requestId);

    this.logger.log(
      `📨 ${method} ${url} - ${userAgent} [${requestId}]`,
    );

    return next.handle().pipe(
      tap({
        next: (data) => {
          const duration = Date.now() - start;
          const contentLength = response.getHeader('content-length') || 0;
          
          this.logger.log(
            `✅ ${method} ${url} - ${response.statusCode} ${duration}ms ${contentLength}bytes [${requestId}]`,
          );
        },
        error: (error) => {
          const duration = Date.now() - start;
          
          this.logger.error(
            `❌ ${method} ${url} - ${error.status || 500} ${duration}ms [${requestId}] - ${error.message}`,
          );
        },
      }),
    );
  }
}