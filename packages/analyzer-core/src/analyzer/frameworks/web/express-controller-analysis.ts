import * as path from 'path';
import * as ts from 'typescript';

export function isExpressControllerSource(content: string, filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const candidatePath = normalizedPath.startsWith('controllers/') ||
    normalizedPath.includes('/controllers/') ||
    normalizedPath.includes('controller.');
  const candidateExport = content.includes('exports.') || content.includes('module.exports');
  if (!candidatePath && !candidateExport) return false;

  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    false,
    filePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  let found = false;
  const isRequestResponseHandler = (node: ts.Node): boolean => {
    if (!ts.isFunctionDeclaration(node) &&
        !ts.isFunctionExpression(node) &&
        !ts.isArrowFunction(node) &&
        !ts.isMethodDeclaration(node)) return false;
    const parameterNames = node.parameters.map(parameter => parameter.name.getText(sourceFile).toLowerCase());
    const hasRequest = parameterNames.some(name => name === 'req' || name === 'request');
    const hasResponse = parameterNames.some(name => name === 'res' || name === 'response');
    return hasRequest && hasResponse;
  };
  const isCommonJsExport = (node: ts.Node): boolean => {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
    const target = node.left.getText(sourceFile);
    return (target.startsWith('exports.') || target === 'module.exports') && isRequestResponseHandler(node.right);
  };
  const visit = (node: ts.Node): void => {
    if (found) return;
    if ((candidatePath && ts.isClassDeclaration(node)) || isCommonJsExport(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

export function extractFirstClassName(content: string): string | null {
  const sourceFile = ts.createSourceFile('source.ts', content, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  let className: string | null = null;
  const visit = (node: ts.Node): void => {
    if (className) return;
    if (ts.isClassDeclaration(node) && node.name) {
      className = node.name.text;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return className;
}

export function extractStaticRequires(content: string): string[] {
  const requires = new Set<string>();
  const sourceFile = ts.createSourceFile('source.ts', content, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require' &&
        node.arguments.length === 1) {
      const argument = node.arguments[0];
      if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) requires.add(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...requires];
}

export function resolveLocalServiceDependency<T extends { filePath: string }>(
  controllerFilePath: string,
  dependency: string,
  services: T[],
): T | undefined {
  if (!dependency.startsWith('.')) return undefined;
  const normalizeModulePath = (value: string): string => {
    const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
    return normalized.replace(/\.(?:[cm]?[jt]sx?)$/, '').replace(/\/index$/, '');
  };
  const controllerPath = controllerFilePath.replace(/\\/g, '/');
  const dependencyPath = normalizeModulePath(path.posix.join(path.posix.dirname(controllerPath), dependency));
  const matches = services.filter(service => normalizeModulePath(service.filePath) === dependencyPath);
  return matches.length === 1 ? matches[0] : undefined;
}
