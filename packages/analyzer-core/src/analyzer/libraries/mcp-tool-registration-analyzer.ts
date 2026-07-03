import { BaseAnalyzer, AnalysisContext } from '../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint } from '../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { glob } from 'glob';

type McpRegistrationKind = 'registerTool' | 'tool' | 'setRequestHandler';

interface McpToolRegistration {
  /** Tool name from the string literal (or best-effort label for setRequestHandler). */
  name: string;
  kind: McpRegistrationKind;
  filePath: string;
  line: number;
  /** The identifier the registration call was made on, e.g. `server` in `server.registerTool(...)`. */
  receiver: string;
  /** Best-effort pointer to the handler — an identifier name if the last arg is a bare reference. */
  handlerRef?: string;
}

/**
 * MCP tool-registration analyzer.
 *
 * The gap: when a codebase itself IS an MCP server, tool names are registered
 * as STRING LITERAL arguments to calls like:
 *
 *   server.registerTool('get_summary', { ... }, handler)
 *   server.tool('do_thing', schema, handler)          // McpServer .tool() shorthand
 *   server.setRequestHandler(ListToolsRequestSchema, handler)
 *
 * These string literals are invisible to search_nodes/semantic_search because
 * they are not named declarations (functions/classes/variables) — they're
 * arguments buried inside call expressions. This analyzer walks source text
 * with a balanced-paren call-arg scanner (mirroring the approach used by
 * express-analyzer.ts / trpc-analyzer.ts in this same directory — regex to
 * find the call head, then a depth-aware scanner to pull out args, since a
 * naive `[^,)]+` regex breaks on object/schema literals and arrow handlers)
 * and emits a searchable `mcp_tool` node for every literal tool name it finds,
 * so "find the get_summary tool" resolves the same way grep would.
 *
 * IN SCOPE:
 *  - `<obj>.registerTool('name', ...)` / `.registerTool("name", ...)` (McpServer SDK)
 *  - `<obj>.tool('name', ...)` shorthand (only when the receiver looks like an
 *    MCP server variable, i.e. named `server`/`mcpServer`/ends in `Server`, to
 *    avoid false positives on unrelated `.tool(...)` calls in other domains)
 *  - `<obj>.setRequestHandler(<SchemaRef>, handler)` — best effort. The "name"
 *    here is not a string literal; we emit a node using the schema identifier
 *    (e.g. `ListToolsRequestSchema`) as the name, flagged
 *    `metadata.attributes.nameSource = 'schema-identifier'` so downstream
 *    consumers know it's inferred, not a literal tool name.
 *
 * EXPLICITLY OUT OF SCOPE (documented, not attempted):
 *  - Dynamically computed tool names (`server.registerTool(TOOL_NAME, ...)`
 *    where TOOL_NAME is a variable/expression, not a literal) — no static
 *    string to index. We skip these silently (no node emitted) rather than
 *    emit a placeholder; a follow-on could resolve simple `const X = 'name'`
 *    bindings but that requires scope-aware analysis this pass doesn't do.
 *  - Tool registration via spread/loop (`tools.forEach(t => server.tool(t.name, ...))`)
 *    — no literal at the call site at all.
 *  - Non-JS/TS MCP SDKs (Python `@mcp.tool()` decorator, etc.) — out of scope
 *    for this pass; same call-site-invisibility problem likely applies there
 *    too and would be a natural follow-on in a Python-specific detector.
 */
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

    const files = await this.getCandidateFiles(context.projectPath);
    const registrations: McpToolRegistration[] = [];

    for (const file of files) {
      const fullPath = path.join(context.projectPath, file);
      let content: string;
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }
      if (!this.hasRegistrationEvidence(content)) continue;

      registrations.push(...this.extractRegisterToolCalls(content, file));
      registrations.push(...this.extractToolShorthandCalls(content, file));
      registrations.push(...this.extractSetRequestHandlerCalls(content, file));
    }

    for (const reg of registrations) {
      const nodeId = `mcp_tool_${this.sanitizeId(reg.name)}_${this.sanitizeId(reg.filePath)}_${reg.line}`;

      const nodeBuilder = this.createNodeBuilder(nodeId, reg.name, 'mcp_tool')
        .withLevel(3, 'code')
        .withCategory('mcp_tool', ['mcp', 'tool-registration'])
        .withSource({ file: path.join(context.projectPath, reg.filePath), line: reg.line, end_line: reg.line })
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
        // CASEntryPoint.type is a closed union without an 'mcp_tool' member;
        // 'message' is the closest existing category for an RPC/tool-call
        // style entry point (the CAS *node* itself still carries the
        // precise 'mcp_tool' type, which is what search/lookup key off of).
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
          line: reg.line
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

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    try {
      return await this.getCandidateFiles(projectPath);
    } catch {
      return [];
    }
  }

  private async getCandidateFiles(projectPath: string): Promise<string[]> {
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
    // `.tool(` shorthand only counts as evidence when the receiver looks like
    // an MCP server variable — otherwise unrelated `.tool()` calls (e.g. a
    // builder pattern in a non-MCP domain) would false-positive canAnalyze.
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

  /** `<receiver>.registerTool('name', ...)` */
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
        handlerRef: this.extractHandlerRef(args)
      });
    }

    return results;
  }

  /** `<receiver>.tool('name', ...)` — McpServer shorthand. Guarded on receiver
   *  naming to avoid false positives from unrelated `.tool()` calls (e.g. a
   *  builder pattern in a non-MCP domain). */
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
        handlerRef: this.extractHandlerRef(args)
      });
    }

    return results;
  }

  /** `<receiver>.setRequestHandler(<SchemaRef>, handler)` — no string literal
   *  name exists here. Best effort: use the schema identifier as the emitted
   *  node's name so it's at least locatable, flagged via nameSource metadata. */
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
        handlerRef: this.extractHandlerRef(args, /* firstArgIsSchema */ true)
      });
    }

    return results;
  }

  /** Best-effort handler reference: if the last parsed arg is a bare
   *  identifier (not an inline arrow/function/object), surface it as the
   *  handler pointer. */
  private extractHandlerRef(args: string[], firstArgIsSchema = false): string | undefined {
    const relevant = firstArgIsSchema ? args.slice(1) : args;
    const last = (relevant[relevant.length - 1] || '').trim();
    if (last && /^[A-Za-z_$][\w$.]*$/.test(last)) {
      return last;
    }
    return undefined;
  }

  private looksLikeMcpServerReceiver(name: string): boolean {
    return /server/i.test(name) || /^mcp/i.test(name);
  }

  /**
   * Parse the arguments of a call starting just after the first argument
   * (i.e. inside the call, depth 1). Splits on top-level commas while
   * respecting nested parens/brackets/braces and string literals, so object
   * literals and arrow-function handlers stay intact as single args.
   * Mirrors ExpressAnalyzer.parseRemainingCallArgs.
   */
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
