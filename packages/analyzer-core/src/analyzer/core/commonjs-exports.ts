export interface TSCommonJsExports {
  roots: Set<string>;
  exportedNames: Set<string>;
  reexports: string[];
}

export function isCommonJsExportObject(index: TSCommonJsExports, objectText: string | undefined): boolean {
  const text = String(objectText || '').replace(/\s+/g, '');
  return text === 'exports' || text === 'module.exports' || index.roots.has(text);
}

export function collectCommonJsExports(root: any): TSCommonJsExports {
  const result: TSCommonJsExports = { roots: new Set(), exportedNames: new Set(), reexports: [] };
  const norm = (node: any): string => String(node?.text || '').replace(/\s+/g, '');
  const isExportsTarget = (node: any): boolean => { const t = norm(node); return t === 'exports' || t === 'module.exports'; };
  const requireSpecifier = (node: any): string | undefined => {
    if (node?.type !== 'call_expression') return undefined;
    if (norm(node.childForFieldName('function')) !== 'require') return undefined;
    const arg = node.childForFieldName('arguments')?.namedChildren?.[0];
    if (!arg || arg.type !== 'string') return undefined;
    return arg.text.replace(/^['"`]|['"`]$/g, '');
  };
  const requireBindings = new Map<string, string>();
  const handleChain = (assignment: any, extraTargets: any[] = []): void => {
    const targets: any[] = [...extraTargets];
    let cursor = assignment;
    while (cursor?.type === 'assignment_expression') {
      targets.push(cursor.childForFieldName('left'));
      cursor = cursor.childForFieldName('right');
    }
    const value = cursor;
    const boundSpecifier = (node: any): string | undefined =>
      requireSpecifier(node) || (node?.type === 'identifier' ? requireBindings.get(node.text) : undefined);
    if (targets.some(isExportsTarget)) {
      for (const target of targets) if (target?.type === 'identifier') result.roots.add(target.text);
      if (value?.type === 'identifier') { result.roots.add(value.text); result.exportedNames.add(value.text); }
      const spec = boundSpecifier(value);
      if (spec) result.reexports.push(spec);
      return;
    }
    for (const target of targets) {
      if (target?.type !== 'member_expression') continue;
      if (!isCommonJsExportObjectFor(result, norm(target.childForFieldName('object')))) continue;
      const property = target.childForFieldName('property')?.text;
      if (property) result.exportedNames.add(property);
      if (value?.type === 'identifier') result.exportedNames.add(value.text);
      const spec = boundSpecifier(value);
      if (spec) result.reexports.push(spec);
    }
  };
  for (const statement of root?.namedChildren || []) {
    if (statement.type === 'expression_statement') {
      const expression = statement.namedChildren?.[0];
      if (expression?.type === 'assignment_expression') handleChain(expression);
    } else if (statement.type === 'lexical_declaration' || statement.type === 'variable_declaration') {
      for (const declarator of statement.namedChildren || []) {
        if (declarator.type !== 'variable_declarator') continue;
        const value = declarator.childForFieldName('value');
        const name = declarator.childForFieldName('name');
        const spec = requireSpecifier(value);
        if (spec && name?.type === 'identifier') requireBindings.set(name.text, spec);
        if (value?.type === 'assignment_expression') handleChain(value, [name]);
      }
    }
  }
  return result;
}

function isCommonJsExportObjectFor(index: TSCommonJsExports, objectText: string): boolean {
  return objectText === 'exports' || objectText === 'module.exports' || index.roots.has(objectText);
}
