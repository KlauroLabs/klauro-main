import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { reidentifyCasTree } from '../../../packages/analyzer-core/src/analyzer/core/recursive-cas';
import type { CrossCodebaseInput } from './cross-codebase-analysis';

export function workspaceMemberReference(repository: CrossCodebaseInput, codebaseId: string): CASOutput {
  const cas = repository.cas;
  return reidentifyCasTree(cas, `workspace:${codebaseId}`, repository.name || cas.system.name);
}
