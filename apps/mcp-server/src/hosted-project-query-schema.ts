import { z } from 'zod';

export const HOSTED_SEARCH_NODES_SCHEMA = z.object({
  query: z.string().min(1),
  type: z.string().optional(),
  file: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
}).strict();
