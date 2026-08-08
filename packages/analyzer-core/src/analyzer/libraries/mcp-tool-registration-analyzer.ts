import { BaseAnalyzer, AnalysisContext } from '../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint } from '../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';

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
  /**
   * Evidence-based fallback when the handler arg is an inline arrow/function
   * body rather than a bare identifier (the overwhelming common case for
   * `server.registerTool('x', schema, async (...) => { ... })`). We scan the
   * inline body text for call-expression callees (`fooBar(...)`,
   * `ns.fooBar(...)`) so a real downstream function can still be linked, e.g.
   * `query.buildSummary(...)` inside the arrow -> function `buildSummary` in
   * query.ts. Never fabricated: these are literal identifiers pulled from the
   * source text of the handler body, just not resolved to a node yet (that
   * happens in the cross-analyzer edge-linking pass).
   */
  handlerCallCandidates?: string[];
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
      // Blank out comments before scanning: this is a plain-text regex scan,
      // not an AST walk, so an illustrative code sample inside a `/** ... */`
      // JSDoc block (this file's own header comment documents the shorthand
      // form as `server.tool('do_thing', schema, handler)`) reads exactly
      // like a real registration and was previously extracted as one —
      // quality-iter-1 #8 traced the junk "Do Thing" workflow's third entry
      // point straight back to that doc example, not real code. Blanking
      // (space-for-non-newline-char) rather than deleting keeps every byte
      // offset and line number produced by extractRegisterToolCalls/etc.
      // identical to scanning the original content.
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
          line: reg.line,
          // Evidence-based candidates for the cross-analyzer edge-linking pass
          // to resolve into a real `calls` edge when handlerRef is absent
          // (the common case: inline arrow/function handler body). Absent or
          // empty when the handler body had nothing resolvable — no edge is
          // fabricated in that case.
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

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    try {
      return await this.getCandidateFiles(projectPath);
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
        handlerRef: this.extractHandlerRef(args),
        handlerCallCandidates: this.extractHandlerCallCandidates(args)
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
        handlerRef: this.extractHandlerRef(args),
        handlerCallCandidates: this.extractHandlerCallCandidates(args)
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
        handlerRef: this.extractHandlerRef(args, /* firstArgIsSchema */ true),
        handlerCallCandidates: this.extractHandlerCallCandidates(args, /* firstArgIsSchema */ true)
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

  /**
   * When the handler arg is an inline arrow/function body (the common case —
   * `extractHandlerRef` returns undefined), pull out plausible callee names
   * from CALL EXPRESSIONS inside that body text: `identifier(...)` or
   * `ns.identifier(...)`. This is text-based, not scope-aware, so it is
   * evidence of "this name appears as a call target inside the handler",
   * not a guarantee of a unique resolution — the cross-analyzer linking pass
   * (orchestrator.linkRouteHandlers) is responsible for resolving a candidate
   * to an actual function node and only then emitting an edge. If the last
   * arg is itself a bare identifier (handled by extractHandlerRef), there is
   * no body text to scan here, so this returns an empty list in that case.
   */
  private extractHandlerCallCandidates(args: string[], firstArgIsSchema = false): string[] {
    const relevant = firstArgIsSchema ? args.slice(1) : args;
    const last = (relevant[relevant.length - 1] || '').trim();
    if (!last || /^[A-Za-z_$][\w$.]*$/.test(last)) return [];

    const candidates: string[] = [];
    const seen = new Set<string>();
    // Matches `foo` or `ns.foo` identifier heads; keeps only the
    // innermost/last member segment (e.g. `query.buildSummary` ->
    // `buildSummary`) alongside the qualified form so either a namespaced or
    // bare function node can match. Whether it's actually a call (optionally
    // through a generic type-argument list, e.g. `apiGet<Foo>(...)`) is
    // checked below with a balanced-bracket scan rather than folded into the
    // regex — a naive `<[^<>(){}]*>` class breaks on the common
    // `Thing<{ items: Foo[] }>(...)` shape (object/array types nested in the
    // generic), silently mis-skipping the real callee.
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
