import * as ts from 'typescript';
import * as path from 'node:path';
import { existsSync } from 'node:fs';

export interface ResolvedMemberCall {
  fromFile: string;
  fromLine: number;
  toFile: string;
  toLine: number;
  name: string;
}

export interface TypeScriptResolutionResult {
  calls: ResolvedMemberCall[];
  filesConsidered: number;
  filesMissing: number;
  memberCallsSeen: number;
  resolvedExternal: number;
  unresolved: number;
}

const EMPTY: TypeScriptResolutionResult = {
  calls: [], filesConsidered: 0, filesMissing: 0, memberCallsSeen: 0, resolvedExternal: 0, unresolved: 0
};

export function typeScriptResolutionEnabled(): boolean {
  return process.env.KLAURO_TS_TYPE_RESOLUTION !== 'off';
}

function isExternalDeclaration(fileName: string): boolean {
  return fileName.includes('node_modules') || fileName.endsWith('.d.ts');
}

export function resolveTypeScriptMemberCalls(
  files: readonly string[],
  projectPath?: string
): TypeScriptResolutionResult {
  const candidates = files
    .filter(file => /\.(ts|tsx|mts|cts)$/.test(file) && !file.endsWith('.d.ts'))
    .map(file => (path.isAbsolute(file) || !projectPath ? file : path.resolve(projectPath, file)));
  const sources = candidates.filter(file => existsSync(file));
  const missing = candidates.length - sources.length;
  if (sources.length === 0) return { ...EMPTY, filesMissing: missing };

  let program: ts.Program;
  try {
    program = ts.createProgram([...sources], {
      allowJs: false,
      noEmit: true,
      skipLibCheck: true,
      skipDefaultLibCheck: true,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022
    });
  } catch {
    return { ...EMPTY, filesMissing: missing };
  }

  const checker = program.getTypeChecker();
  const calls: ResolvedMemberCall[] = [];
  let memberCallsSeen = 0;
  let resolvedExternal = 0;
  let unresolved = 0;

  for (const file of sources) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    const visit = (node: ts.Node): void => {
      const callee = ts.isCallExpression(node)
        ? (ts.isPropertyAccessExpression(node.expression) ? node.expression.name
          : (ts.isIdentifier(node.expression) ? node.expression : undefined))
        : undefined;
      if (callee) {
        memberCallsSeen += 1;
        let symbol = checker.getSymbolAtLocation(callee);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        const declaration = symbol?.declarations?.[0];
        if (!declaration) {
          unresolved += 1;
        } else {
          const declarationFile = declaration.getSourceFile();
          if (isExternalDeclaration(declarationFile.fileName)) {
            resolvedExternal += 1;
          } else {
            calls.push({
              fromFile: file,
              fromLine: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
              toFile: declarationFile.fileName,
              toLine: declarationFile.getLineAndCharacterOfPosition(declaration.getStart()).line + 1,
              name: callee.getText()
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return { calls, filesConsidered: sources.length, filesMissing: missing, memberCallsSeen, resolvedExternal, unresolved };
}
