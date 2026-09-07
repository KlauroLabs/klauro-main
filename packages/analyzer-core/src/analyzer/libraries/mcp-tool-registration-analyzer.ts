import { BaseAnalyzer, AnalysisContext } from '../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint } from '../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';
import * as ts from 'typescript';

type McpRegistrationKind = 'registerTool' | 'tool' | 'setRequestHandler';
type McpDescriptionVerdict = Pick<McpToolRegistration, 'description' | 'descriptionSource' | 'descriptionLine' | 'descriptionEndLine'>;

interface McpToolRegistration {

  name: string;
  kind: McpRegistrationKind;
  filePath: string;
  line: number;

  receiver: string;

  description?: string;
  descriptionSource: 'string-literal' | 'template-literal' | 'dynamic' | 'absent';
  descriptionLine?: number;
  descriptionEndLine?: number;
  column?: number;

  handlerRef?: string;











  handlerCallCandidates?: string[];
}












































export class McpToolRegistrationAnalyzer extends BaseAnalyzer {
  constructor() {
    super('mcp-tool-registration', 'MCP Tool Registration Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (await fs.pathExists(packageJsonPath)) {
        const packageJson = await fs.readJson(packageJsonPath);
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        if (Object.keys(deps).some(d => d === '@modelcontextprotocol/sdk')) {
          return true;
        }
      }

      const files = await this.getCandidateFiles(projectPath);
      for (const file of files) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (this.hasRegistrationEvidence(content)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    const files = await this.getCandidateFiles(context.projectPath, context);
    const registrations: McpToolRegistration[] = [];

    for (const file of files) {
      const fullPath = path.join(context.projectPath, file);
      let content: string;
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }










      const scannable = this.blankComments(content);
      if (!this.hasRegistrationEvidence(scannable)) continue;

      const found = [
        ...this.extractRegisterToolCalls(scannable, file),
        ...this.extractToolShorthandCalls(scannable, file),
        ...this.extractSetRequestHandlerCalls(scannable, file),
      ];
      this.applyAuthoredDescriptions(content, found);
      registrations.push(...found);
    }
    const siteCounts = new Map<string, number>();
    for (const reg of registrations) {
      const key = `${reg.filePath}:${reg.name}:${reg.line}`;
      siteCounts.set(key, (siteCounts.get(key) || 0) + 1);
    }

    for (const reg of registrations) {
      const sharedLine = (siteCounts.get(`${reg.filePath}:${reg.name}:${reg.line}`) || 0) > 1;
      const nodeId = `mcp_tool_${this.sanitizeId(reg.name)}_${this.sanitizeId(reg.filePath)}_${reg.line}${sharedLine && reg.column !== undefined ? `_c${reg.column}` : ''}`;

      const nodeBuilder = this.createNodeBuilder(nodeId, reg.name, 'mcp_tool')
        .withLevel(3, 'code')
        .withCategory('mcp_tool', ['mcp', 'tool-registration'])
        .withSource({ file: reg.filePath, line: reg.line, end_line: reg.line })
        .withDescription(reg.description ?? `MCP tool registration: ${reg.name} (via ${reg.receiver}.${reg.kind}())`)
        .withMetadata({
          attributes: {
            mcp: true,
            registrationKind: reg.kind,
            receiver: reg.receiver,
            handlerRef: reg.handlerRef,
            nameSource: reg.kind === 'setRequestHandler' ? 'schema-identifier' : 'string-literal',
            descriptionSource: reg.descriptionSource,
            descriptionLine: reg.descriptionLine
          }
        });

      const node = nodeBuilder.build();
      if (reg.description !== undefined) {
        node.description_source = 'deterministic';
        node.documentation = {
          format: 'other',
          type: 'other',
          raw: reg.description,
          description: reg.description,
          summary: reg.description.split(/(?<=[.!?])\s+/)[0],
          location: { start_line: reg.descriptionLine ?? reg.line, end_line: reg.descriptionEndLine ?? reg.descriptionLine ?? reg.line }
        };
      }
      nodes.push(node);

      entryPoints.push({
        id: `entry_${nodeId}`,
        name: reg.name,
        ...(reg.description !== undefined ? { description: reg.description, description_source: 'deterministic' } : {}),




        type: 'message',
        source_node: nodeId,
        source_analyzer: this.analyzerId,
        trigger: {
          method: reg.kind,
          path: reg.name
        },
        handler: reg.handlerRef
          ? { node_id: nodeId, method_name: reg.handlerRef, file: reg.filePath }
          : { node_id: nodeId, method_name: reg.name, file: reg.filePath },
        metadata: {
          registrationKind: reg.kind,
          receiver: reg.receiver,
          file: reg.filePath,
          line: reg.line,
          descriptionSource: reg.descriptionSource,
          descriptionLine: reg.descriptionLine,
          descriptionEndLine: reg.descriptionEndLine,





          handlerCallCandidates: reg.handlerCallCandidates && reg.handlerCallCandidates.length > 0
            ? reg.handlerCallCandidates
            : undefined
        }
      } as CASEntryPoint);
    }

    return this.createContribution(nodes, edges, entryPoints, exitPoints, {
      api: 'mcp-tool-registration',
      toolsFound: nodes.length,
      registerToolCount: registrations.filter(r => r.kind === 'registerTool').length,
      toolShorthandCount: registrations.filter(r => r.kind === 'tool').length,
      setRequestHandlerCount: registrations.filter(r => r.kind === 'setRequestHandler').length
    });
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string, context?: AnalysisContext): Promise<string[]> {
    try {
      return await this.getCandidateFiles(projectPath, context);
    } catch {
      return [];
    }
  }

  private async getCandidateFiles(projectPath: string, context?: AnalysisContext): Promise<string[]> {
    if (context?.existingAnalysis?.length) {
      const groundedFiles = this.filesFromExistingAnalysis(
        context,
        source => source === '@modelcontextprotocol/sdk' || source.startsWith('@modelcontextprotocol/sdk/'),
        true
      );
      const conventionFiles = await glob([
        '**/*{mcp,tool,tools,server,registry,registration}*.{ts,tsx,js,jsx,mjs,cjs}',
        '**/{mcp,tools}/**/*.{ts,tsx,js,jsx,mjs,cjs}',
      ], {
        cwd: projectPath,
        ignore: [...this.getIgnorePatterns(context), '**/*.test.*', '**/*.spec.*', '**/__tests__/**'],
        nodir: true,
      });
      return [...new Set([...groundedFiles, ...conventionFiles])].sort();
    }
    return glob(['**/*.{ts,tsx,js,jsx,mjs,cjs}'], {
      cwd: projectPath,
      ignore: [...this.getIgnorePatterns({ projectPath }), '**/*.test.*', '**/*.spec.*', '**/__tests__/**'],
      nodir: true
    });
  }

  private hasRegistrationEvidence(content: string): boolean {
    if (/\.registerTool\s*\(/.test(content) || /\.setRequestHandler\s*\(/.test(content)) {
      return true;
    }



    const shorthand = /([A-Za-z_$][\w$]*)\s*\.\s*tool\s*\(\s*['"`]/g;
    let match;
    while ((match = shorthand.exec(content)) !== null) {
      if (this.looksLikeMcpServerReceiver(match[1])) return true;
    }
    return false;
  }

  private lineAt(content: string, index: number): number {
    return content.slice(0, index).split('\n').length;
  }


  private extractRegisterToolCalls(content: string, filePath: string): McpToolRegistration[] {
    const results: McpToolRegistration[] = [];
    const head = /([A-Za-z_$][\w$]*)\s*\.\s*registerTool\s*\(\s*(['"`])([^'"`]+)\2/g;

    let match;
    while ((match = head.exec(content)) !== null) {
      const receiver = match[1];
      const name = match[3];
      const args = this.parseRemainingCallArgs(content, head.lastIndex);
      results.push({
        name,
        kind: 'registerTool',
        filePath,
        line: this.lineAt(content, match.index),
        receiver,
        descriptionSource: 'dynamic',
        handlerRef: this.extractHandlerRef(args),
        handlerCallCandidates: this.extractHandlerCallCandidates(args)
      });
    }

    return results;
  }




  private extractToolShorthandCalls(content: string, filePath: string): McpToolRegistration[] {
    const results: McpToolRegistration[] = [];
    const head = /([A-Za-z_$][\w$]*)\s*\.\s*tool\s*\(\s*(['"`])([^'"`]+)\2/g;

    let match;
    while ((match = head.exec(content)) !== null) {
      const receiver = match[1];
      if (!this.looksLikeMcpServerReceiver(receiver)) continue;
      const name = match[3];
      const args = this.parseRemainingCallArgs(content, head.lastIndex);
      results.push({
        name,
        kind: 'tool',
        filePath,
        line: this.lineAt(content, match.index),
        receiver,
        descriptionSource: 'dynamic',
        handlerRef: this.extractHandlerRef(args),
        handlerCallCandidates: this.extractHandlerCallCandidates(args)
      });
    }

    return results;
  }




  private extractSetRequestHandlerCalls(content: string, filePath: string): McpToolRegistration[] {
    const results: McpToolRegistration[] = [];
    const head = /([A-Za-z_$][\w$]*)\s*\.\s*setRequestHandler\s*\(\s*([A-Za-z_$][\w$]*)/g;

    let match;
    while ((match = head.exec(content)) !== null) {
      const receiver = match[1];
      const schemaRef = match[2];
      const args = this.parseRemainingCallArgs(content, match.index + match[0].length - schemaRef.length);
      results.push({
        name: schemaRef,
        kind: 'setRequestHandler',
        filePath,
        line: this.lineAt(content, match.index),
        receiver,
        descriptionSource: 'absent',
        handlerRef: this.extractHandlerRef(args,   true),
        handlerCallCandidates: this.extractHandlerCallCandidates(args,   true)
      });
    }

    return results;
  }




  private applyAuthoredDescriptions(content: string, registrations: McpToolRegistration[]): void {
    let source: ts.SourceFile;
    try {
      source = ts.createSourceFile('registrations.ts', content, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    } catch {
      return;
    }
    const pending = new Map<string, McpToolRegistration[]>();
    for (const reg of registrations) {
      if (reg.kind === 'setRequestHandler') continue;
      const key = `${reg.kind}:${reg.name}:${reg.line}`;
      const bucket = pending.get(key);
      if (bucket) bucket.push(reg); else pending.set(key, [reg]);
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const first = node.arguments[0];
        if ((method === 'registerTool' || method === 'tool') && first && this.isPlainStringLiteral(first)) {
          const position = source.getLineAndCharacterOfPosition(node.getStart(source));
          const reg = pending.get(`${method}:${first.text}:${position.line + 1}`)?.shift();
          if (reg) {
            reg.column = position.character + 1;
            Object.assign(reg, method === 'registerTool'
              ? this.describeConfigObject(node.arguments[1], source)
              : this.describePositional(node.arguments[1], source));
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  private isPlainStringLiteral(node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
    return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
  }

  private literalVerdict(node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral, source: ts.SourceFile): McpDescriptionVerdict {
    return {
      description: node.text,
      descriptionSource: ts.isStringLiteral(node) ? 'string-literal' : 'template-literal',
      descriptionLine: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      descriptionEndLine: source.getLineAndCharacterOfPosition(node.end).line + 1,
    };
  }

  private describePositional(arg: ts.Expression | undefined, source: ts.SourceFile): McpDescriptionVerdict {
    if (!arg || ts.isObjectLiteralExpression(arg)) return { descriptionSource: 'absent' };
    if (this.isPlainStringLiteral(arg)) return this.literalVerdict(arg, source);
    return { descriptionSource: 'dynamic' };
  }

  private describeConfigObject(arg: ts.Expression | undefined, source: ts.SourceFile): McpDescriptionVerdict {
    if (!arg) return { descriptionSource: 'absent' };
    if (!ts.isObjectLiteralExpression(arg)) return { descriptionSource: 'dynamic' };
    let verdict: McpDescriptionVerdict = { descriptionSource: 'absent' };
    let uncertain = false;
    for (const property of arg.properties) {
      if (ts.isSpreadAssignment(property)) {
        uncertain = true;
        if (verdict.descriptionSource !== 'absent') verdict = { descriptionSource: 'dynamic' };
        continue;
      }
      const name = property.name;
      if (!name) continue;
      let key: string | undefined;
      if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || this.isPlainStringLiteral(name) || ts.isNumericLiteral(name)) key = name.text;
      else if (ts.isComputedPropertyName(name) && this.isPlainStringLiteral(name.expression)) key = name.expression.text;
      else { uncertain = true; continue; }
      if (key !== 'description') continue;
      uncertain = false;
      verdict = ts.isPropertyAssignment(property) && this.isPlainStringLiteral(property.initializer)
        ? this.literalVerdict(property.initializer, source)
        : { descriptionSource: 'dynamic' };
    }
    return verdict.descriptionSource === 'absent' && uncertain ? { descriptionSource: 'dynamic' } : verdict;
  }

  private extractHandlerRef(args: string[], firstArgIsSchema = false): string | undefined {
    const relevant = firstArgIsSchema ? args.slice(1) : args;
    const last = (relevant[relevant.length - 1] || '').trim();
    if (last && /^[A-Za-z_$][\w$.]*$/.test(last)) {
      return last;
    }
    return undefined;
  }













  private extractHandlerCallCandidates(args: string[], firstArgIsSchema = false): string[] {
    const relevant = firstArgIsSchema ? args.slice(1) : args;
    const last = (relevant[relevant.length - 1] || '').trim();
    if (!last || /^[A-Za-z_$][\w$.]*$/.test(last)) return [];

    const candidates: string[] = [];
    const seen = new Set<string>();









    const identifierPattern = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;
    const skip = new Set([
      'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'async',
      'await', 'json', 'JSON', 'Boolean', 'String', 'Number', 'Array', 'Object',
      'Promise', 'Error', 'new'
    ]);
    let m;
    while ((m = identifierPattern.exec(last)) !== null) {
      const qualified = m[1];
      const parts = qualified.split('.');
      const bare = parts[parts.length - 1];
      if (skip.has(bare) || skip.has(qualified)) continue;

      let i = identifierPattern.lastIndex;
      while (i < last.length && /\s/.test(last[i])) i++;
      if (last[i] === '<') {
        let depth = 0;
        let j = i;
        for (; j < last.length; j++) {
          if (last[j] === '<') depth++;
          else if (last[j] === '>') { depth--; if (depth === 0) { j++; break; } }
        }
        if (depth !== 0) continue;
        i = j;
        while (i < last.length && /\s/.test(last[i])) i++;
      }
      if (last[i] !== '(') continue;

      if (!seen.has(qualified)) { seen.add(qualified); candidates.push(qualified); }
      if (bare !== qualified && !seen.has(bare)) { seen.add(bare); candidates.push(bare); }
    }
    return candidates;
  }

  private looksLikeMcpServerReceiver(name: string): boolean {
    return /server/i.test(name) || /^mcp/i.test(name);
  }








  private parseRemainingCallArgs(content: string, pos: number): string[] {
    const args: string[] = [];
    let depth = 1;
    let cur = '';
    let inStr: string | null = null;
    for (let i = pos; i < content.length; i++) {
      const ch = content[i];
      if (inStr) {
        cur += ch;
        if (ch === inStr && content[i - 1] !== '\\') inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') { depth++; cur += ch; continue; }
      if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) { if (cur.trim()) args.push(cur.trim()); break; }
        cur += ch;
        continue;
      }
      if (ch === ',' && depth === 1) { if (cur.trim()) args.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    return args;
  }

  protected getCapabilities(): string[] {
    return [
      'mcp-tool-registration-detection',
      'registerTool-extraction',
      'tool-shorthand-extraction',
      'setRequestHandler-best-effort'
    ];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'system';
      case 2: return 'architectural';
      case 3: return 'code';
      case 4: return 'member';
      case 5: return 'implementation';
      default: return `level_${level}`;
    }
  }
}
