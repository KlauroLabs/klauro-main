import { z } from 'zod';

export const FIND_TESTS_QUERY_SCHEMA = z.object({
  node_id: z.string().optional().describe('Node ID to find tests for'),
  file_path: z.string().optional().describe('File path to find tests for'),
  suite_id: z.string().optional().describe('Suite ID; limit/offset then page its test cases'),
  limit: z.number().int().positive().max(200).optional().describe('Max suites, or tests with suite_id (default 25)'),
  offset: z.number().int().nonnegative().optional().describe('Skip first N suites, or tests with suite_id'),
}).strict();

export const FIND_TESTS_INPUT_SCHEMA = {
  path: z.string().describe('Project path'),
  ...FIND_TESTS_QUERY_SCHEMA.shape,
};
