export function maskCStyleComments(
  content: string,
  options: { singleQuotedStrings?: boolean } = {},
): string {
  let output = '';
  let index = 0;
  let quote: '"' | "'" | null = null;
  let lineComment = false;
  let blockComment = false;

  while (index < content.length) {
    const current = content[index];
    const next = content[index + 1] || '';
    if (lineComment) {
      output += current === '\n' ? '\n' : ' ';
      if (current === '\n') lineComment = false;
      index += 1;
      continue;
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        output += '  ';
        blockComment = false;
        index += 2;
      } else {
        output += current === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }
    if (quote) {
      output += current;
      if (current === '\\') {
        output += next;
        index += 2;
      } else {
        if (current === quote) quote = null;
        index += 1;
      }
      continue;
    }
    if (current === '/' && next === '/') {
      output += '  ';
      lineComment = true;
      index += 2;
      continue;
    }
    if (current === '/' && next === '*') {
      output += '  ';
      blockComment = true;
      index += 2;
      continue;
    }
    if (current === '"' || (current === "'" && options.singleQuotedStrings !== false)) quote = current;
    output += current;
    index += 1;
  }

  return output;
}
