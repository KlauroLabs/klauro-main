export interface CapabilityLifecycleOperation {
  action?: string;
  path_or_command?: string;
  trigger?: { method?: string; path?: string };
}

const authenticationPath = (value: string): boolean =>
  /(?:^|[/_-])(?:auth(?:enticate)?|login|sign[ _-]?in|token)(?:$|[/_?&#-])/.test(value) &&
  !/(?:^|[/_-])(?:register|registration|sign[ _-]?up)(?:$|[/_?&#-])/.test(value);

export function canonicalCapabilityLifecycleAction(operation: CapabilityLifecycleOperation): string {
  const action = String(operation.action || '').trim().toLowerCase();
  const method = String(operation.trigger?.method || '').trim().toUpperCase();
  const path = String(operation.trigger?.path || operation.path_or_command || '').trim().toLowerCase();
  if (/(?:^|[/_.-])decline/.test(path)) return 'decline';
  if (/(?:^|[/_.-])accept/.test(path)) return 'accept';
  if (/(?:^|[/_.-])test/.test(path)) return 'test';
  if (/^(?:execute|run)$/.test(action)) return 'run';
  if (method === 'POST' && authenticationPath(path)) return 'authenticate';
  if (method === 'DELETE') {
    if (/(?:^|[/_-])follow(?:$|[/_?&#-])/.test(path)) return 'unfollow';
    if (/(?:^|[/_-])favou?rite(?:$|[/_?&#-])/.test(path)) return 'unfavorite';
    return 'delete';
  }
  if (/^(?:delete|remove|unfollow|unfavorite|unfavour|unmark|withdraw|cancel|archive)$/.test(action)) return action;
  if (action) return action;
  if (/^(?:GET|HEAD|OPTIONS)$/.test(method)) return 'read';
  if (method === 'POST') return 'create';
  if (/^(?:PUT|PATCH)$/.test(method)) return 'update';
  return '';
}

export function observedCapabilityLifecycleActions(
  operations: readonly CapabilityLifecycleOperation[],
): string[] {
  return [...new Set(operations.map(canonicalCapabilityLifecycleAction).filter(Boolean))];
}

export function capabilityDescriptionExpressesDestructiveLifecycle(description: string): boolean {
  return /\b(?:delet(?:e|es|ed|ing|ion)|remov(?:e|es|ed|ing|al)|unfollow(?:s|ed|ing)?|unfavou?r(?:e|es|ed|ing|ite|ites|ited|iting)?|unmark(?:s|ed|ing)?|withdraw(?:s|n|ing)?|cancel(?:s|ed|led|ing|ling)?|archiv(?:e|es|ed|ing)|manage)\b/i.test(description);
}

export function capabilityHasObservedDestructiveLifecycle(
  operations: readonly CapabilityLifecycleOperation[],
): boolean {
  return observedCapabilityLifecycleActions(operations).some(action =>
    /^(?:delete|remove|unfollow|unfavorite|unfavour|unmark|withdraw|cancel|archive)$/.test(action));
}
