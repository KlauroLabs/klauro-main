import type { CASEntryPoint } from '../../types/cas.types';

export type EntryPointSubjectField = 'event' | 'pattern' | 'path' | 'name';

export function selectEntryPointSubjectField(
  entries: readonly CASEntryPoint[],
  fields: readonly EntryPointSubjectField[] = ['event', 'pattern', 'name'],
): EntryPointSubjectField {
  let selected: EntryPointSubjectField = 'event';
  let highestCount = -1;
  for (const field of fields) {
    const values = entries.map(entry => field === 'name' ? entry.name : entry.trigger?.[field]);
    const count = new Set(values.filter(Boolean)).size;
    if (count > highestCount) {
      selected = field;
      highestCount = count;
    }
  }
  return selected;
}
