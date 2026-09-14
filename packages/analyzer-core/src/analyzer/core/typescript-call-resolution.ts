import * as ts from 'typescript';

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
  memberCallsSeen: number;
  resolvedExternal: number;
  unresolved: number;
}

const EMPTY: TypeScriptResolutionResult = {
  calls: [], filesConsidered: 0, memberCallsSeen: 0, resolvedExternal: 0, unresolved: 0
};

export function typeScriptResolutionEnabled(): boolean {
  return process.env.KLAURO_TS_TYPE_RESOLUTION === 'on';
}

function isExternalDeclaration(fileName: string): boolean {
  return fileName.includes('node_modules') || fileName.endsWith('.d.ts');
}

export function resolveTypeScriptMemberCalls(files: readonly string[]): TypeScriptResolutionResult {
  const sources = files.filter(file => /\.(ts|tsx|mts|cts)$/.test(file) && !file.endsWith('.d.ts'));
  if (sources.length === 0) return EMPTY;

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
    return EMPTY;
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
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        memberCallsSeen += 1;
        const declaration = checker.getSymbolAtLocation(node.expression.name)?.declarations?.[0];
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
              name: node.expression.name.getText()
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return { calls, filesConsidered: sources.length, memberCallsSeen, resolvedExternal, unresolved };
}
