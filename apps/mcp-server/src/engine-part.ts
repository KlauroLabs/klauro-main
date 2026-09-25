import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

export function partBornAt(cas: CASOutput, root: string): CASOutput | undefined {
  if (!root) return undefined;
  const pending = [...(cas.children || [])];
  while (pending.length > 0) {
    const child = pending.shift()!;
    const at = child.system?.root_path || '';
    if (at === root || at.endsWith(`/${root}`)) return child;
    pending.push(...(child.children || []));
  }
  return undefined;
}
