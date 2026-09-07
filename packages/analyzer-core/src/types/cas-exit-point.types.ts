import type { CASDescriptionGeneration } from './cas.types';

export const EXIT_POINT_TYPES = [
  'database', 'api', 'file', 'message', 'event', 'cache', 'sdk',
  'webhook', 'navigation', 'client_storage', 'analytics',
] as const;

export type CASExitPointType = typeof EXIT_POINT_TYPES[number];

export interface CASExitPoint {
  id: string;
  source_node: string;
  source_analyzer?: string;
  type: CASExitPointType;
  name: string;
  description?: string;
  description_source?: 'deterministic' | 'ai' | 'manual' | 'reused';
  description_generation?: CASDescriptionGeneration;
  target?: {
    service_id?: string;
    endpoint?: string;
    resource?: string;
    sdk?: string;
  };
  operation?: {
    action?: string;
    method?: string;
    async?: boolean;
  };
  data?: {
    input_type?: string;
    output_type?: string;
    transformation_node?: string;
  };
  reliability?: {
    retry_attempts?: number;
    timeout_ms?: number;
    circuit_breaker?: boolean;
  };
  connected_nodes?: string[];
  metadata?: Record<string, any>;
}
