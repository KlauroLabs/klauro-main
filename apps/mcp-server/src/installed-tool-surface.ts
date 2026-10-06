import { isInstalledToolName } from './installed-tool-registry';

const TOOL_NAME_LIST_KEYS = new Set(['follow_up_tools', 'required_tools', 'detail_tools']);

function hasToolField(item: unknown): item is { tool: string } {
  return Boolean(item) && typeof item === 'object' && typeof (item as { tool?: unknown }).tool === 'string';
}

function constrainStepList(items: unknown[]): unknown[] {
  const kept = items.filter(item => !hasToolField(item) || isInstalledToolName(item.tool));
  return kept.map((item, index) => (
    item && typeof item === 'object' && typeof (item as { order?: unknown }).order === 'number'
      ? { ...(item as Record<string, unknown>), order: index + 1 }
      : item
  ));
}

export function constrainToInstalledTools<T>(value: T): T {
  if (Array.isArray(value)) {
    const mapped = value.map(item => constrainToInstalledTools(item));
    return (mapped.some(hasToolField) ? constrainStepList(mapped) : mapped) as unknown as T;
  }
  if (!value || typeof value !== 'object') return value;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (TOOL_NAME_LIST_KEYS.has(key) && Array.isArray(entry)) {
      next[key] = entry.filter(name => typeof name !== 'string' || isInstalledToolName(name));
    } else if (key === 'detail_tool' && typeof entry === 'string' && !isInstalledToolName(entry)) {
      continue;
    } else if (key === 'suggested_tool' && hasToolField(entry) && !isInstalledToolName(entry.tool)) {
      next[key] = null;
    } else {
      next[key] = constrainToInstalledTools(entry);
    }
  }
  return next as T;
}
