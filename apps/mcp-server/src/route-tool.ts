import { z } from 'zod';
import type { CasSectionName } from './cas-sections';

export const ROUTE_SECTIONS: CasSectionName[] = ['identity', 'graph', 'calls', 'comprehension'];

export const ROUTE_TOOL_CONFIG = {
  title: 'Get Route',
  description: 'The path, or up to max_paths shortest distinct paths, between two arbitrary functions, steps, flows, entry points or nodes. Each hop names its edge kind, how the analysis found that edge (via: structure = proven from imports and types, name = matched by name alone, rule = framework rule) and the file and line it is declared at. The result states its bound: max depth, max paths, whether the search was truncated, and when no path exists whether that is because the trail ran into calls the analysis could not resolve (open_end), a path longer than the bound (beyond_depth_bound), or because the two are disconnected in the analysis. `from` and `to` accept a node id, a unique name, an entry point id, a flow id or a step id (flowId:stepId).',
  inputSchema: {
    path: z.string().describe('Project path'),
    from: z.string().describe('Start: node id, unique name, entry point id, flow id or step id'),
    to: z.string().describe('End: node id, unique name, entry point id, flow id or step id'),
    max_depth: z.number().optional().describe('Longest route in hops (default 8)'),
    max_paths: z.number().optional().describe('Most distinct paths to return, shortest first (default 3)'),
  } as any,
};
