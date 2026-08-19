export function stripJavaCommentsPreserveLines(content: string): string {
  let output = '';
  let blockComment = false;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    const next = content[index + 1];
    if (blockComment) {
      if (character === '*' && next === '/') {
        output += '  ';
        index++;
        blockComment = false;
      } else {
        output += character === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      output += character;
      continue;
    }
    if (character === '/' && next === '*') {
      output += '  ';
      index++;
      blockComment = true;
      continue;
    }
    if (character === '/' && next === '/') {
      while (index < content.length && content[index] !== '\n') {
        output += ' ';
        index++;
      }
      if (index < content.length) output += '\n';
      continue;
    }
    output += character;
  }
  return output;
}

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
