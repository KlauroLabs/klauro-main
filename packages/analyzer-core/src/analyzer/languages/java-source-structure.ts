export function findClassSpringMappingPath(lines: string[], classLineIndex: number): string {
  const annotations: string[] = [];
  for (let index = classLineIndex - 1; index >= Math.max(0, classLineIndex - 20); index--) {
    const line = lines[index].trim();
    if (!line) continue;
    if (line.startsWith('@')) {
      annotations.unshift(line);
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*') || line.startsWith('*/')) continue;
    break;
  }
  const annotationText = annotations.join(' ');
  const match = annotationText.match(
    /@RequestMapping\s*\(\s*(?:(?:value|path)\s*=\s*)?(?:\{\s*)?["']([^"']+)["']/
  );
  return match?.[1] || '';
}

export function joinSpringRoutePaths(classPath: string, methodPath: string): string {
  const joined = `/${classPath}/${methodPath}`.replace(/\/{2,}/g, '/');
  const normalized = joined.replace(/\{([A-Za-z_$][\w$]*)(?::[^}]+)?\}/g, ':$1');
  return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
}
