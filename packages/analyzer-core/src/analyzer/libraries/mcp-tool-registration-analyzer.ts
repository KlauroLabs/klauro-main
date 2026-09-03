import { BaseAnalyzer, AnalysisContext } from '../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint } from '../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';

type McpRegistrationKind = 'registerTool' | 'tool' | 'setRequestHandler';

interface McpToolRegistration {

  name: string;
  kind: McpRegistrationKind;
  filePath: string;
  line: number;

  receiver: string;

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

      registrations.push(...this.extractRegisterToolCalls(scannable, file));
      registrations.push(...this.extractToolShorthandCalls(scannable, file));
      registrations.push(...this.extractSetRequestHandlerCalls(scannable, file));
    }

    for (const reg of registrations) {
      const nodeId = `mcp_tool_${this.sanitizeId(reg.name)}_${this.sanitizeId(reg.filePath)}_${reg.line}`;

      const nodeBuilder = this.createNodeBuilder(nodeId, reg.name, 'mcp_tool')
        .withLevel(3, 'code')
        .withCategory('mcp_tool', ['mcp', 'tool-registration'])
        .withSource({ file: reg.filePath, line: reg.line, end_line: reg.line })
        .withDescription(`MCP tool registration: ${reg.name} (via ${reg.receiver}.${reg.kind}())`)
        .withMetadata({
          attributes: {
            mcp: true,
            registrationKind: reg.kind,
            receiver: reg.receiver,
            handlerRef: reg.handlerRef,
            nameSource: reg.kind === 'setRequestHandler' ? 'schema-identifier' : 'string-literal'
          }
        });

      const node = nodeBuilder.build();
      nodes.push(node);

      entryPoints.push({
        id: `entry_${nodeId}`,
        name: reg.name,




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
        handlerRef: this.extractHandlerRef(args,   true),
        handlerCallCandidates: this.extractHandlerCallCandidates(args,   true)
      });
    }

    return results;
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
