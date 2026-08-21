import { z } from 'zod';

const boundedSearchText = z.string().min(1).max(1024)
  .refine(value => Buffer.byteLength(value, 'utf8') <= 4096, 'Search text exceeds 4096 UTF-8 bytes');

export const HOSTED_SEARCH_NODES_SCHEMA = z.object({
  query: boundedSearchText,
  type: z.string().max(256).optional(),
  file: z.string().max(4096).optional(),
  limit: z.number().int().positive().max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
}).strict();
