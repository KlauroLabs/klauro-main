import type { CASEntryPoint } from '../../types/cas.types';

export function unshippedRoleOf(entryPoint: CASEntryPoint): string | undefined {
  const held = (entryPoint.metadata as { unshipped?: { role?: unknown } } | undefined)?.unshipped;
  return typeof held?.role === 'string' ? held.role : undefined;
}
