import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ErrorResponseDto } from '../dto/error-response.dto';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const correlationId = this.generateCorrelationId();
    const timestamp = new Date().toISOString();
    const path = request.url;

    let errorResponse: ErrorResponseDto;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      errorResponse = this.createErrorResponse(
        status,
        exceptionResponse,
        correlationId,
        timestamp,
        path,
      );
    } else {
      errorResponse = this.createUnknownErrorResponse(
        correlationId,
        timestamp,
        path,
      );

      this.logger.error(
        `Unhandled exception: ${exception}`,
        exception instanceof Error ? exception.stack : undefined,
        { correlationId, path, method: request.method },
      );
    }

    this.logger.error(
      `HTTP ${errorResponse.statusCode} ${errorResponse.code}: ${errorResponse.message}`,
      { correlationId, path, method: request.method, details: errorResponse.details },
    );

    response.status(errorResponse.statusCode).json(errorResponse);
  }

  private createErrorResponse(
    status: number,
    exceptionResponse: any,
    correlationId: string,
    timestamp: string,
    path: string,
  ): ErrorResponseDto {
    if (typeof exceptionResponse === 'string') {
      return {
        statusCode: status,
        code: this.getErrorCode(status),
        message: exceptionResponse,
        correlationId,
        timestamp,
        path,
      };
    }

    const details = this.extractValidationDetails(exceptionResponse);

    return {
      statusCode: status,
      code: this.getErrorCode(status, exceptionResponse.error),
      message: exceptionResponse.message || this.getDefaultMessage(status),
      details: details.length > 0 ? details : undefined,
      correlationId,
      timestamp,
      path,
    };
  }

  private createUnknownErrorResponse(
    correlationId: string,
    timestamp: string,
    path: string,
  ): ErrorResponseDto {
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
      correlationId,
      timestamp,
      path,
    };
  }

  private extractValidationDetails(exceptionResponse: any): string[] {
    if (Array.isArray(exceptionResponse.message)) {
      return exceptionResponse.message;
    }

    if (exceptionResponse.details && Array.isArray(exceptionResponse.details)) {
      return exceptionResponse.details;
    }

    return [];
  }

  private getErrorCode(status: number, errorType?: string): string {
    if (errorType) {
      return errorType.toUpperCase().replace(/\s+/g, '_');
    }

    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'BAD_REQUEST';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHORIZED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return 'VALIDATION_FAILED';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'RATE_LIMIT_EXCEEDED';
      case HttpStatus.INTERNAL_SERVER_ERROR:
        return 'INTERNAL_SERVER_ERROR';
      default:
        return 'UNKNOWN_ERROR';
    }
  }

  private getDefaultMessage(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'Bad request';
      case HttpStatus.UNAUTHORIZED:
        return 'Authentication required';
      case HttpStatus.FORBIDDEN:
        return 'Access denied';
      case HttpStatus.NOT_FOUND:
        return 'Resource not found';
      case HttpStatus.CONFLICT:
        return 'Resource conflict';
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return 'Validation failed';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'Rate limit exceeded';
      case HttpStatus.INTERNAL_SERVER_ERROR:
        return 'Internal server error';
      default:
        return 'An error occurred';
    }
  }

  private generateCorrelationId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}