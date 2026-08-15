import * as path from 'path';
import type { CASNode } from '../../types/cas.types';

type HandlerResolver = (handlerFile: string, handlerName: string) => CASNode | undefined;

function normalizedFile(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

function withoutExtension(file: string): string {
  return file.replace(/\.[^/.]+$/, '').replace(/\/index$/, '');
}

function sourceMatchesModule(sourceFile: string, handlerFile: string, moduleReference: string): boolean {
  const normalizedSource = withoutExtension(normalizedFile(sourceFile));
  const normalizedReference = normalizedFile(moduleReference);
  const modulePath = normalizedReference.startsWith('.')
    ? normalizedFile(path.posix.join(path.posix.dirname(normalizedFile(handlerFile)), normalizedReference))
    : normalizedReference.replace(/\./g, '/');
  const target = withoutExtension(modulePath).replace(/^\/+/, '');
  return normalizedSource === target || normalizedSource.endsWith(`/${target}`);
}

function importedSymbolMatches(node: CASNode, handlerName: string): boolean {
  const metadata = node.metadata as Record<string, unknown> | undefined;
  if (node.name === handlerName || metadata?.fromImport === handlerName) return true;
  const imported = metadata?.imported;
  return Array.isArray(imported) && imported.includes(handlerName);
}

export function buildImportedHandlerResolver(nodes: CASNode[]): HandlerResolver {
  const importsByFile = new Map<string, CASNode[]>();
  const functionsByName = new Map<string, CASNode[]>();
  for (const node of nodes) {
    const file = normalizedFile(node.source?.file || '');
    if (node.type === 'import' && file) {
      const imports = importsByFile.get(file) || [];
      imports.push(node);
      importsByFile.set(file, imports);
    }
    if (node.type === 'function' || node.type === 'method') {
      const functions = functionsByName.get(node.name) || [];
      functions.push(node);
      functionsByName.set(node.name, functions);
    }
  }

  return (handlerFile, handlerName) => {
    const normalizedHandlerFile = normalizedFile(handlerFile);
    const imports = [...importsByFile]
      .filter(([file]) => file === normalizedHandlerFile || file.endsWith(`/${normalizedHandlerFile}`) || normalizedHandlerFile.endsWith(`/${file}`))
      .flatMap(([, fileImports]) => fileImports)
      .filter(node => importedSymbolMatches(node, handlerName));
    const modules = imports
      .map(node => {
        const metadata = node.metadata as Record<string, unknown> | undefined;
        return typeof metadata?.module === 'string'
          ? metadata.module
          : typeof metadata?.source === 'string' ? metadata.source : undefined;
      })
      .filter((moduleReference): moduleReference is string => Boolean(moduleReference));
    const matches = (functionsByName.get(handlerName) || []).filter(candidate => {
      const sourceFile = candidate.source?.file;
      return Boolean(sourceFile && modules.some(moduleReference =>
        sourceMatchesModule(sourceFile, normalizedHandlerFile, moduleReference)
      ));
    });
    return matches.length === 1 ? matches[0] : undefined;
  };
}
