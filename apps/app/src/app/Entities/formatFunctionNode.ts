export function formatFunctionNodeLabel(nodeId: string): string {
  const parts = nodeId.split('_');

  const methodMatch = nodeId.match(/_([A-Za-z0-9]+)_(\d+)_([A-Za-z0-9]+)_(\d+)$/);
  if (methodMatch) {
    const [, className, , methodName] = methodMatch;
    return `${className}.${methodName}`;
  }
  const last = parts[parts.length - 1];
  return last || nodeId;
}
