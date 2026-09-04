export function calculateComplexity(func: any): number {
  let complexity = 1;
  const body = func.childForFieldName('body');
  if (!body) return complexity;

  const complexityNodes = new Set([
    'if_statement', 'ternary_expression', 'switch_case',
    'for_statement', 'for_in_statement', 'for_of_statement',
    'while_statement', 'do_statement',
    'catch_clause',
    'binary_expression'
  ]);

  const stack = [body];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (!node) continue;
    if (complexityNodes.has(node.type)) {
      if (node.type === 'binary_expression') {
        const op = node.childForFieldName('operator')?.text;
        if (op === '&&' || op === '||' || op === '??') {
          complexity++;
        }
      } else {
        complexity++;
      }
    }
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }

  return complexity;
}
