export interface ParsedJavaParameter {
  name: string;
  type: string;
  annotations: string[];
  isFinal: boolean;
}

function balancedParenthesizedContent(value: string): string | undefined {
  const start = value.indexOf('(');
  if (start < 0) return undefined;
  let depth = 0;
  for (let index = start; index < value.length; index++) {
    if (value[index] === '(') depth += 1;
    else if (value[index] === ')') {
      depth -= 1;
      if (depth === 0) return value.slice(start + 1, index);
    }
  }
  return undefined;
}

function splitTopLevelParameters(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (const character of value) {
    if (character === '(' || character === '<' || character === '[') depth += 1;
    else if (character === ')' || character === '>' || character === ']') depth -= 1;
    if (character === ',' && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function extractJavaReturnType(line: string): string {
  const open = line.indexOf('(');
  if (open < 0) return '';
  const prefix = line.slice(0, open).trim();
  const methodName = prefix.match(/([A-Za-z_$][\w$]*)$/)?.[1];
  if (!methodName) return '';
  return prefix
    .slice(0, prefix.length - methodName.length)
    .replace(/@\w+(?:\s*\([^)]*\))?\s*/g, '')
    .replace(/\b(?:public|private|protected|static|final|abstract|synchronized|native|default)\b/g, '')
    .replace(/^\s*<[^>]+>\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractJavaParameters(line: string): ParsedJavaParameter[] {
  const source = balancedParenthesizedContent(line);
  if (!source?.trim()) return [];
  return splitTopLevelParameters(source).flatMap(rawParameter => {
    const annotations = [...rawParameter.matchAll(/@(\w+)(?:\s*\([^)]*\))?/g)].map(match => match[1]);
    const declaration = rawParameter
      .replace(/@\w+(?:\s*\([^)]*\))?\s*/g, '')
      .replace(/\bfinal\b/g, '')
      .trim();
    const parts = declaration.split(/\s+/).filter(Boolean);
    if (parts.length < 2) return [];
    return [{
      name: parts[parts.length - 1],
      type: parts.slice(0, -1).join(' '),
      annotations,
      isFinal: /\bfinal\b/.test(rawParameter),
    }];
  });
}
