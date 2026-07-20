/**
 * Lifecycle readers/writers are raw function-node ids, e.g.
 * "method_class_packages/analyzer-core/src/.../analysis-repository.ts_AnalysisRepository_1_create_1"
 * — a real token shape, not a display label (mirrors the entry-points
 * lane's `looksLikeRawToken`/`formatTrigger` convention for the same
 * problem). This extracts a best-effort "Class.method" label and always
 * keeps the raw id available for the link target — never fabricates a
 * name it can't support from the token itself.
 */
export function formatFunctionNodeLabel(nodeId: string): string {
  const parts = nodeId.split('_');
  // Trailing pattern is usually `<ClassName>_<index>_<methodName>_<line>`.
  const methodMatch = nodeId.match(/_([A-Za-z0-9]+)_(\d+)_([A-Za-z0-9]+)_(\d+)$/);
  if (methodMatch) {
    const [, className, , methodName] = methodMatch;
    return `${className}.${methodName}`;
  }
  const last = parts[parts.length - 1];
  return last || nodeId;
}
