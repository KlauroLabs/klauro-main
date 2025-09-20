import { Injectable, Optional } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicator } from '@nestjs/terminus';
import { EntityManager } from '@mikro-orm/core';

@Injectable()
export class HealthService extends HealthIndicator {
  constructor(
    @Optional() private readonly em?: EntityManager,
  ) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    if (!this.em) {
      return this.getStatus(key, true, {
        database: 'disabled',
        timestamp: new Date().toISOString(),
      });
    }
    
    try {
      // Check database connection
      await this.em.getConnection().execute('SELECT 1');
      
      return this.getStatus(key, true, {
        database: 'up',
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      return this.getStatus(key, false, {
        database: 'down',
        error: error?.message || 'Unknown error',
        timestamp: new Date().toISOString(),
      });
    }
  }
}