import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  CASComment, CASTodo, FileAnalysisResult
} from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';
import * as path from 'path';

type SolContractKind = 'contract' | 'interface' | 'library' | 'abstract-contract';
type SolFunctionKind = 'function' | 'constructor' | 'modifier' | 'receive' | 'fallback';

interface SolFunction {
  name: string;
  kind: SolFunctionKind;
  visibility?: 'public' | 'external' | 'internal' | 'private';
  mutability?: 'view' | 'pure' | 'payable' | 'nonpayable';
  lineStart: number;
  lineEnd: number;
  bodyCalls: Array<{ name: string; line: number }>;
  externalCalls: Array<{ member: string; line: number }>;
  /** Member calls `expr.method(...)` — resolved against `using LIB for T`
   *  library functions AND contract-instance receivers (`a.save()` where
   *  `a` is an `Account`) in emitCallEdges. */
  memberCalls: Array<{ receiver: string; name: string; line: number }>;
  /** Local/param variable -> contract type, for receiver-type resolution. */
  receiverTypes: Record<string, string>;
}

interface SolEvent {
  name: string;
  lineNumber: number;
}

interface SolStateVar {
  name: string;
  type: string;
  visibility?: string;
  lineNumber: number;
}

interface SolContract {
  name: string;
  kind: SolContractKind;
  bases: string[];
  lineStart: number;
  lineEnd: number;
  functions: SolFunction[];
  events: SolEvent[];
  stateVars: SolStateVar[];
  /** Library names brought in via `using LIB for T` — used to resolve member
   *  calls (`x.method()`) to the library's function. */
  usingLibs: string[];
}

interface SolImport {
  rawPath: string;
  lineNumber: number;
}

interface SolFileInfo {
  relativePath: string;
  fullPath: string;
  contracts: SolContract[];
  imports: SolImport[];
  pragmas: string[];
  license?: string;
  lineCount: number;
}

const SOL_EXTENSIONS = ['.sol'];
// Solidity keywords that must never be treated as a called function.
const SOL_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'return', 'returns', 'require', 'assert',
  'revert', 'emit', 'new', 'delete', 'using', 'is', 'memory', 'storage', 'calldata',
  'public', 'external', 'internal', 'private', 'view', 'pure', 'payable', 'virtual',
  'override', 'function', 'modifier', 'constructor', 'mapping', 'struct', 'enum',
  'event', 'contract', 'interface', 'library', 'abstract', 'unchecked', 'try', 'catch',
  'address', 'uint', 'int', 'bool', 'string', 'bytes', 'true', 'false', 'this', 'super',
  'wei', 'gwei', 'ether', 'seconds', 'minutes', 'hours', 'days', 'weeks', 'type',
]);
// Member calls on an address/contract that leave this contract (exit points).
const EXTERNAL_CALL_MEMBERS = new Set(['call', 'delegatecall', 'staticcall', 'transfer', 'send']);

export class SolidityAnalyzer extends BaseAnalyzer {

  constructor() {
    super(
      'solidity',
      'Solidity Analyzer',
      '1.0.0',
      'language'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const files = await this.findSolidityFiles(projectPath, { projectPath });
      return files.length > 0;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await this.findSolidityFiles(projectPath, { projectPath });
    return files.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    const info = this.parseSolidityFile(context.relativePath, context.filePath, content);
    const fileById = new Map<string, SolFileInfo>([[info.relativePath, info]]);

    this.emitFileNodes(info, content, nodes, edges, entryPoints, exitPoints);
    if (this.isSolidityTestFile(info.relativePath)) this.applyTestFileBoundary(nodes);
    this.emitInheritanceEdges([info], edges);
    this.emitCallEdges([info], edges);
    this.emitImportEdges([info], context.projectPath, fileById, edges);

    const imports = info.imports.map(i => i.rawPath);
    const exports = info.contracts.map(c => c.name);

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      imports,
      exports
    );
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    this.resetAnalysisWarnings();
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      let solFiles = await this.findSolidityFiles(context.projectPath, context);
      solFiles.sort();
      solFiles = this.capAndPrioritizeSourceFiles(solFiles, 'solidity contracts');

      const fileInfos: SolFileInfo[] = [];
      const fileById = new Map<string, SolFileInfo>();
      for (const relativePath of solFiles) {
        const fullPath = path.join(context.projectPath, relativePath);
        let content = '';
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }
        const info = this.parseSolidityFile(relativePath, fullPath, content);
        fileInfos.push(info);
        fileById.set(this.normalize(info.relativePath), info);
      }

      for (const info of fileInfos) {
        const content = await fs.readFile(info.fullPath, 'utf-8').catch(() => '');
        const before = nodes.length;
        this.emitFileNodes(info, content, nodes, edges, entryPoints, exitPoints);
        if (this.isSolidityTestFile(info.relativePath)) {
          this.applyTestFileBoundary(nodes.slice(before));
        }
      }

      this.emitInheritanceEdges(fileInfos, edges);
      this.emitCallEdges(fileInfos, edges);
      this.emitImportEdges(fileInfos, context.projectPath, fileById, edges);

      const warnings = this.collectAnalysisWarnings();
      const contractCount = nodes.filter(n => n.type === 'class').length;
      const fnCount = nodes.filter(n => n.type === 'function' || n.type === 'method').length;
      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        ...(warnings.length > 0 ? { warnings } : {}),
        framework_specific: {
          language: 'solidity',
          packageManager: 'unknown',
          filesAnalyzed: fileInfos.length,
          contractsFound: contractCount,
          functionsFound: fnCount
        }
      });
    } catch (error) {
      throw new AnalyzerError(
        `Solidity analysis failed: ${(error as Error).message}`,
        'SOLIDITY_ANALYSIS_ERROR'
      );
    }
  }

  private async findSolidityFiles(projectPath: string, context: AnalysisContext): Promise<string[]> {
    const ignore = this.getIgnorePatterns(context);
    const files = await glob(['**/*.sol'], {
      cwd: projectPath,
      ignore,
      nodir: true
    });
    return files;
  }

  /**
   * Foundry/Hardhat's own Solidity test conventions: Foundry's `forge test`
   * default naming is `*.t.sol`, and both toolchains conventionally keep
   * Solidity test contracts under a `test/`/`tests/` directory — never a
   * shared cross-language filename heuristic (Hardhat's OWN unit tests are
   * usually JS/TS, out of scope for this analyzer entirely).
   */
  private isSolidityTestFile(relativePath: string): boolean {
    const lower = relativePath.toLowerCase();
    return /\.t\.sol$/.test(lower) || /(^|\/)tests?\/.*\.sol$/.test(lower);
  }

  /**
   * Tags every node belonging to a Foundry/Hardhat Solidity test file with
   * `metadata.is_test`, `category: 'test'`, and a `test-code` tag, mirroring
   * go-analyzer.ts's applyTestFileBoundary. Without this, Solidity test
   * functions (which DO carry `calls`/instance-call edges into production
   * contracts via emitCallEdges) carried no test-owned marker of any kind,
   * so the cross-language coverage-graph walk (test-framework-analyzer.ts's
   * isTestOwnedNode / graphNodesForSuite) could never start a traversal from
   * this analyzer's own function nodes — only from TestFrameworkAnalyzer's
   * synthetic suite/case nodes, which carry no `calls` edges of their own.
   * See also the 'foundry' FrameworkRule added to test-framework-analyzer.ts,
   * needed for the SAME reason XCTest needed one for Swift: without it no
   * suite/case is ever discovered for Solidity at all.
   */
  private applyTestFileBoundary(fileNodes: CASNode[]): void {
    for (const node of fileNodes) {
      node.metadata = { ...node.metadata, is_test: true };
      node.category = 'test';
      node.subcategories = [...new Set([...(node.subcategories || []), node.type, 'test-code'])];
      node.tags = [...new Set([...(node.tags || []), 'test-code'])];
    }
  }

  // ---- Parsing -------------------------------------------------------------

  private parseSolidityFile(relativePath: string, fullPath: string, content: string): SolFileInfo {
    const lines = content.split('\n');
    const stripped = this.stripComments(content).split('\n');

    const pragmas: string[] = [];
    let license: string | undefined;
    const imports: SolImport[] = [];

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const licenseMatch = raw.match(/SPDX-License-Identifier:\s*(\S+)/);
      if (licenseMatch && !license) license = licenseMatch[1];

      const code = stripped[i] || '';
      const pragmaMatch = code.match(/pragma\s+([^;]+);/);
      if (pragmaMatch) pragmas.push(pragmaMatch[1].trim());

      // import "..."; or import {X} from "..."; or import X from "...";
      const importMatch = code.match(/^\s*import\s+(?:\{[^}]*\}\s*from\s*|[A-Za-z0-9_]+\s*from\s*)?["']([^"']+)["']/);
      if (importMatch) imports.push({ rawPath: importMatch[1], lineNumber: i + 1 });
    }

    const contracts = this.extractContracts(stripped);

    return {
      relativePath,
      fullPath,
      contracts,
      imports,
      pragmas,
      license,
      lineCount: lines.length,
    };
  }

  private extractContracts(lines: string[]): SolContract[] {
    const contracts: SolContract[] = [];
    const headerRe = /^\s*(abstract\s+)?(contract|interface|library)\s+([A-Za-z_]\w*)([^{]*)/;

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(headerRe);
      if (!match) continue;

      const isAbstract = !!match[1];
      const baseKind = match[2] as 'contract' | 'interface' | 'library';
      const name = match[3];
      const rest = match[4] || '';
      const kind: SolContractKind = isAbstract && baseKind === 'contract' ? 'abstract-contract' : baseKind;

      const bases = this.extractBases(rest);
      const lineStart = i + 1;
      const lineEnd = this.findBlockEnd(lines, i);

      const body = lines.slice(i, lineEnd);
      const functions = this.extractFunctions(body, lineStart - 1);
      const events = this.extractEvents(body, lineStart - 1);
      const stateVars = this.extractStateVars(body, lineStart - 1, functions);
      const usingLibs = this.extractUsingLibs(body);

      contracts.push({ name, kind, bases, lineStart, lineEnd, functions, events, stateVars, usingLibs });
    }
    return contracts;
  }

  // `using LIB for T;` / `using LIB for T global;` -> ['LIB']
  private extractUsingLibs(body: string[]): string[] {
    const libs = new Set<string>();
    for (const line of body) {
      const m = line.match(/^\s*using\s+([A-Za-z_]\w*)\s+for\b/);
      if (m) libs.add(m[1]);
    }
    return [...libs];
  }

  // `is A, B(args), C` -> [A, B, C]
  private extractBases(headerRest: string): string[] {
    const isMatch = headerRest.match(/\bis\b(.*)$/);
    if (!isMatch) return [];
    const list = isMatch[1];
    const bases: string[] = [];
    // Split on commas at depth 0 (ignore constructor-arg parens).
    let depth = 0;
    let current = '';
    for (const ch of list) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) { bases.push(current); current = ''; continue; }
      current += ch;
    }
    if (current.trim()) bases.push(current);
    return bases
      .map(b => b.replace(/\(.*$/, '').trim())
      .filter(b => /^[A-Za-z_]\w*$/.test(b));
  }

  private extractFunctions(body: string[], lineOffset: number): SolFunction[] {
    const functions: SolFunction[] = [];
    // function name(...) ... ; or { ... }
    const fnRe = /^\s*(function\s+([A-Za-z_]\w*)|constructor|fallback\s*\(|receive\s*\(|modifier\s+([A-Za-z_]\w*))/;

    for (let i = 1; i < body.length; i++) {
      const line = body[i];
      const m = line.match(fnRe);
      if (!m) continue;

      let kind: SolFunctionKind;
      let name: string;
      if (m[2]) { kind = 'function'; name = m[2]; }
      else if (m[3]) { kind = 'modifier'; name = m[3]; }
      else if (/^\s*constructor/.test(line)) { kind = 'constructor'; name = 'constructor'; }
      else if (/^\s*fallback/.test(line)) { kind = 'fallback'; name = 'fallback'; }
      else if (/^\s*receive/.test(line)) { kind = 'receive'; name = 'receive'; }
      else continue;

      // Collect the full signature (may span lines) up to `{` or `;`.
      let sigEnd = i;
      let signature = line;
      while (sigEnd < body.length && !/[{;]/.test(body[sigEnd])) {
        sigEnd++;
        if (sigEnd < body.length) signature += ' ' + body[sigEnd];
      }
      const isDeclarationOnly = /;/.test(body[sigEnd] || '') && !/\{/.test(signature);

      const visibility = this.matchVisibility(signature);
      const mutability = this.matchMutability(signature);

      const absStart = lineOffset + i + 1;
      let bodyEnd: number;
      let bodyCalls: SolFunction['bodyCalls'] = [];
      let externalCalls: SolFunction['externalCalls'] = [];
      let memberCalls: SolFunction['memberCalls'] = [];
      let receiverTypes: Record<string, string> = {};
      if (isDeclarationOnly) {
        bodyEnd = lineOffset + sigEnd + 1;
        receiverTypes = this.extractSolReceiverTypes(signature, []);
      } else {
        const openIdx = this.findOpenBraceLine(body, i);
        const closeRel = openIdx >= 0 ? this.findBlockEnd(body, openIdx) : sigEnd + 1;
        bodyEnd = lineOffset + closeRel;
        const bodyLines = body.slice(i, closeRel);
        bodyCalls = this.extractBodyCalls(bodyLines, absStart);
        externalCalls = this.extractExternalCalls(bodyLines, absStart);
        memberCalls = this.extractMemberCalls(bodyLines, absStart);
        receiverTypes = this.extractSolReceiverTypes(signature, bodyLines);
      }

      functions.push({
        name, kind, visibility, mutability,
        lineStart: absStart, lineEnd: bodyEnd,
        bodyCalls, externalCalls, memberCalls, receiverTypes,
      });
    }
    return functions;
  }

  private matchVisibility(sig: string): SolFunction['visibility'] {
    if (/\bexternal\b/.test(sig)) return 'external';
    if (/\bpublic\b/.test(sig)) return 'public';
    if (/\binternal\b/.test(sig)) return 'internal';
    if (/\bprivate\b/.test(sig)) return 'private';
    return undefined;
  }

  private matchMutability(sig: string): SolFunction['mutability'] {
    if (/\bpayable\b/.test(sig)) return 'payable';
    if (/\bview\b/.test(sig)) return 'view';
    if (/\bpure\b/.test(sig)) return 'pure';
    return undefined;
  }

  private extractBodyCalls(bodyLines: string[], absStart: number): Array<{ name: string; line: number }> {
    const calls: Array<{ name: string; line: number }> = [];
    for (let i = 0; i < bodyLines.length; i++) {
      const line = bodyLines[i];
      const re = /(?:^|[^.\w])([A-Za-z_]\w*)\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const name = m[1];
        if (SOL_KEYWORDS.has(name)) continue;
        calls.push({ name, line: absStart + i });
      }
    }
    return calls;
  }

  private extractExternalCalls(bodyLines: string[], absStart: number): Array<{ member: string; line: number }> {
    const found: Array<{ member: string; line: number }> = [];
    for (let i = 0; i < bodyLines.length; i++) {
      const line = bodyLines[i];
      const re = /\.\s*(call|delegatecall|staticcall|transfer|send)\b/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        if (EXTERNAL_CALL_MEMBERS.has(m[1])) found.push({ member: m[1], line: absStart + i });
      }
    }
    return found;
  }

  /** Member calls `expr.method(...)` — the candidates for `using LIB for T`
   *  resolution. Excludes the low-level external-call builtins (handled
   *  separately as exit points). Resolution to a library happens in
   *  emitCallEdges, gated on the contract's `using` directives, so this stays
   *  conservative (a bare member name alone never creates an edge). */
  private extractMemberCalls(bodyLines: string[], absStart: number): Array<{ receiver: string; name: string; line: number }> {
    const found: Array<{ receiver: string; name: string; line: number }> = [];
    for (let i = 0; i < bodyLines.length; i++) {
      const re = /(\w+)\s*\.\s*([A-Za-z_]\w*)\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(bodyLines[i])) !== null) {
        const receiver = m[1];
        const name = m[2];
        if (SOL_KEYWORDS.has(name) || EXTERNAL_CALL_MEMBERS.has(name)) continue;
        found.push({ receiver, name, line: absStart + i });
      }
    }
    return found;
  }

  /** Map param/local variables to their contract type for receiver resolution:
   *  signature params (`Account a`) and contract-typed locals (`Account a = …`). */
  private extractSolReceiverTypes(signature: string, bodyLines: string[]): Record<string, string> {
    const types: Record<string, string> = {};
    const paramMatch = signature.match(/\(([^)]*)\)/);
    if (paramMatch) {
      for (const part of paramMatch[1].split(',')) {
        const pm = part.trim().match(/^([A-Z]\w*)(?:\s+(?:memory|storage|calldata))?\s+([A-Za-z_]\w*)$/);
        if (pm) types[pm[2]] = pm[1];
      }
    }
    for (const ln of bodyLines) {
      const lm = ln.match(/^\s*([A-Z]\w*)(?:\s+(?:memory|storage|calldata))?\s+([A-Za-z_]\w*)\s*=/);
      if (lm) types[lm[2]] = lm[1];
    }
    return types;
  }

  private extractEvents(body: string[], lineOffset: number): SolEvent[] {
    const events: SolEvent[] = [];
    for (let i = 1; i < body.length; i++) {
      const m = body[i].match(/^\s*event\s+([A-Za-z_]\w*)\s*\(/);
      if (m) events.push({ name: m[1], lineNumber: lineOffset + i + 1 });
    }
    return events;
  }

  private extractStateVars(body: string[], lineOffset: number, functions: SolFunction[]): SolStateVar[] {
    const vars: SolStateVar[] = [];
    const fnRanges = functions.map(f => [f.lineStart, f.lineEnd] as const);
    const typeRe = /^\s*((?:mapping\s*\([^;]*\)|address|bool|string|bytes\d*|bytes|u?int\d*|[A-Z]\w*)(?:\s*\[[^\]]*\])?)\s+((?:public|private|internal|constant|immutable|override)\s+)*([A-Za-z_]\w*)\s*(?:=|;)/;
    for (let i = 1; i < body.length; i++) {
      const absLine = lineOffset + i + 1;
      // Skip lines inside function bodies (those are locals, not state).
      if (fnRanges.some(([s, e]) => absLine > s && absLine <= e)) continue;
      const line = body[i];
      if (/^\s*(function|modifier|constructor|event|struct|enum|error|using|fallback|receive)\b/.test(line)) continue;
      const m = line.match(typeRe);
      if (!m) continue;
      const visMatch = line.match(/\b(public|private|internal)\b/);
      vars.push({
        type: m[1].replace(/\s+/g, ' ').trim(),
        name: m[3],
        visibility: visMatch ? visMatch[1] : undefined,
        lineNumber: absLine,
      });
    }
    return vars;
  }

  // ---- Node / edge emission ------------------------------------------------

  private emitFileNodes(
    info: SolFileInfo,
    content: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[]
  ): void {
    const fileId = this.fileId(info.relativePath);
    const baseName = info.relativePath.split('/').pop() || 'unknown.sol';
    const fileComments = this.extractCommentsFromFile(content, info.fullPath);
    const fileTodos = this.extractTodosFromComments(fileComments, info.fullPath);

    nodes.push(this.createNodeBuilder(fileId, baseName, 'file')
      .withLevel(1, 'File/Module')
      .withCategory('modules', ['solidity-files'])
      .withSource({ file: info.fullPath, line: 1, end_line: info.lineCount })
      .withMetadata({
        language: 'solidity',
        attributes: {
          license: info.license,
          pragmas: info.pragmas,
          contractCount: info.contracts.length,
          importCount: info.imports.length,
          extension: '.sol',
          commentCount: fileComments.length,
          todoCount: fileTodos.length
        }
      })
      .withComments(fileComments.length > 0 ? fileComments : undefined)
      .withTodos(fileTodos.length > 0 ? fileTodos : undefined)
      .build());

    for (const contract of info.contracts) {
      const contractId = this.contractId(info.relativePath, contract.name);
      const contractComments = fileComments.filter(c =>
        c.location.line >= contract.lineStart && c.location.line <= contract.lineEnd
      );

      const contractNode = this.createNodeBuilder(contractId, contract.name, 'class')
        .withLevel(2, 'Contract')
        .withCategory('structures', ['solidity-contracts'])
        .withSource({ file: info.fullPath, line: contract.lineStart, end_line: contract.lineEnd })
        .withMetadata({
          language: 'solidity',
          is_abstract: contract.kind === 'abstract-contract',
          attributes: {
            kind: contract.kind,
            bases: contract.bases,
            functionCount: contract.functions.length,
            eventCount: contract.events.length,
            stateVarCount: contract.stateVars.length,
            file: info.relativePath
          }
        })
        .withTags([`analyzer:${this.id}`, `solidity-${contract.kind}`])
        .withComments(contractComments.length > 0 ? contractComments : undefined)
        .build();
      contractNode.qualified_name = `${info.relativePath}:${contract.name}`;
      nodes.push(contractNode);

      edges.push(this.createEdge(
        `${fileId}_contains_${contractId}`,
        fileId,
        contractId,
        'contains'
      ));

      // State variables as field nodes.
      for (const sv of contract.stateVars) {
        const fieldId = `field_${contractId}_${this.sanitizeId(sv.name)}`;
        nodes.push(this.createNode(
          fieldId, sv.name, 'field', 4, info.fullPath, sv.lineNumber, sv.lineNumber,
          { language: 'solidity', attributes: { type: sv.type, visibility: sv.visibility } }
        ));
        edges.push(this.createEdge(`${contractId}_has_field_${fieldId}`, contractId, fieldId, 'has_field'));
      }

      // Event nodes.
      for (const ev of contract.events) {
        const eventId = `event_${contractId}_${this.sanitizeId(ev.name)}`;
        nodes.push(this.createNode(
          eventId, ev.name, 'event', 4, info.fullPath, ev.lineNumber, ev.lineNumber,
          { language: 'solidity', attributes: { contract: contract.name } }
        ));
        edges.push(this.createEdge(`${contractId}_declares_${eventId}`, contractId, eventId, 'declares'));
      }

      // Function / constructor / modifier nodes.
      for (const fn of contract.functions) {
        const fnId = this.functionId(contractId, fn.name, fn.lineStart);
        const isEntry = fn.visibility === 'public' || fn.visibility === 'external' ||
          fn.kind === 'constructor' || fn.kind === 'fallback' || fn.kind === 'receive';

        const fnNode = this.createNodeBuilder(fnId, fn.name, 'method')
          .withLevel(4, 'Function')
          .withCategory('methods', ['solidity-functions'])
          .withSource({ file: info.fullPath, line: fn.lineStart, end_line: fn.lineEnd })
          .withParent(contractId)
          .withMetadata({
            language: 'solidity',
            access_modifier: fn.visibility === 'external' ? 'public'
              : (fn.visibility as 'public' | 'private' | 'protected' | undefined),
            attributes: {
              is_payable: fn.mutability === 'payable',
              kind: fn.kind,
              visibility: fn.visibility,
              mutability: fn.mutability,
              contract: contract.name,
              file: info.relativePath
            }
          })
          .withTags([
            `analyzer:${this.id}`,
            ...(fn.visibility ? [`visibility:${fn.visibility}`] : []),
            ...(fn.mutability ? [`mutability:${fn.mutability}`] : []),
            `solidity-${fn.kind}`
          ])
          .build();
        fnNode.qualified_name = `${contract.name}.${fn.name}`;
        nodes.push(fnNode);

        edges.push(this.createEdge(`${contractId}_has_method_${fnId}`, contractId, fnId, 'has_method'));

        if (isEntry) {
          entryPoints.push(this.createEntryPoint(
            `entry_${fnId}`,
            fnId,
            'message',
            `${contract.name}.${fn.name}`,
            `Solidity ${fn.kind}${fn.visibility ? ` (${fn.visibility})` : ''}${fn.mutability ? ` ${fn.mutability}` : ''}`,
            { method: fn.kind, pattern: fn.name },
            fn.mutability === 'payable' ? { authenticated: false } : undefined,
            {
              file: info.relativePath,
              line: fn.lineStart,
              contract: contract.name,
              kind: fn.kind,
              visibility: fn.visibility,
              mutability: fn.mutability,
              language: 'solidity'
            },
            { node_id: fnId, method_name: fn.name, file: info.relativePath, line: fn.lineStart }
          ));
        }

        // External calls -> exit points.
        for (const ext of fn.externalCalls) {
          const exitId = `exit_${fnId}_${ext.member}_${ext.line}`;
          exitPoints.push(this.createExitPoint(
            exitId,
            fnId,
            ext.member === 'transfer' || ext.member === 'send' ? 'message' : 'api',
            `External call: .${ext.member}()`,
            `Low-level external ${ext.member} (value/calldata leaves the contract)`,
            { resource: ext.member, sdk: 'evm' },
            { action: ext.member, method: 'external-call' },
            { member: ext.member, line: ext.line, contract: contract.name, language: 'solidity' }
          ));
        }
      }
    }
  }

  private emitInheritanceEdges(fileInfos: SolFileInfo[], edges: CASEdge[]): void {
    const edgeIds = new Set(edges.map(e => e.id));
    // Map base contract name -> its node id (first definition wins; cross-file resolution).
    const byName = new Map<string, string>();
    for (const info of fileInfos) {
      for (const c of info.contracts) {
        if (!byName.has(c.name)) byName.set(c.name, this.contractId(info.relativePath, c.name));
      }
    }
    for (const info of fileInfos) {
      for (const c of info.contracts) {
        const sourceId = this.contractId(info.relativePath, c.name);
        for (const base of c.bases) {
          const targetId = byName.get(base);
          if (!targetId || targetId === sourceId) continue;
          const edgeId = `${sourceId}_inherits_${targetId}`;
          if (edgeIds.has(edgeId)) continue;
          edgeIds.add(edgeId);
          edges.push(this.createEdge(
            edgeId, sourceId, targetId, 'inherits', 'structure',
            { base_name: base, contract_name: c.name, language: 'solidity' }
          ));
        }
      }
    }
  }

  private emitCallEdges(fileInfos: SolFileInfo[], edges: CASEdge[]): void {
    const edgeIds = new Set(edges.map(e => e.id));
    // Index every contract by name (across files) so a bare call can resolve to
    // a function inherited from a base contract (`contract Vault is Ownable`),
    // not just one declared in the same contract.
    const contractByName = new Map<string, { info: SolFileInfo; contract: SolContract }>();
    for (const info of fileInfos) {
      for (const contract of info.contracts) contractByName.set(contract.name, { info, contract });
    }

    for (const info of fileInfos) {
      for (const contract of info.contracts) {
        const contractId = this.contractId(info.relativePath, contract.name);

        for (const caller of contract.functions) {
          const callerId = this.functionId(contractId, caller.name, caller.lineStart);
          const seenTargets = new Set<string>();
          for (const call of caller.bodyCalls) {
            // Resolve within this contract first, then up the inheritance chain.
            const resolved = this.resolveFunctionInChain(contractByName, contract, info, call.name, new Set());
            if (!resolved) continue;
            const target = resolved.fn;
            // Skip self-recursion / the declaration line itself.
            if (resolved.contract.name === contract.name && target.lineStart === caller.lineStart) continue;
            const targetContractId = this.contractId(resolved.info.relativePath, resolved.contract.name);
            const targetId = this.functionId(targetContractId, target.name, target.lineStart);
            if (targetId === callerId) continue;
            if (seenTargets.has(targetId)) continue;
            seenTargets.add(targetId);
            const edgeId = `call_${callerId}_to_${targetId}`;
            if (edgeIds.has(edgeId)) continue;
            edgeIds.add(edgeId);
            edges.push(this.createEdge(
              edgeId, callerId, targetId, 'calls', 'behavior',
              { line: call.line, callType: 'function', language: 'solidity' }
            ));
          }

          // `using LIB for T` member calls: `x.method()` resolves to LIB.method
          // only when the contract declares `using LIB for ...` and LIB (a
          // library) defines `method`. Gating on the directive keeps this from
          // linking arbitrary `.foo()` member accesses (no false positives).
          for (const call of caller.memberCalls) {
            // Contract-instance receiver: `a.save()` where `a` is typed `Account`
            // resolves to Account.save only (excludes same-name methods elsewhere).
            const recvType = call.receiver === 'this' ? contract.name : caller.receiverTypes[call.receiver];
            if (recvType) {
              const targetEntry = contractByName.get(recvType);
              const target = targetEntry?.contract.functions.find(f => f.name === call.name);
              if (targetEntry && target) {
                const targetContractId = this.contractId(targetEntry.info.relativePath, targetEntry.contract.name);
                const targetId = this.functionId(targetContractId, target.name, target.lineStart);
                if (targetId !== callerId && !seenTargets.has(targetId)) {
                  seenTargets.add(targetId);
                  const edgeId = `call_${callerId}_to_${targetId}`;
                  if (!edgeIds.has(edgeId)) {
                    edgeIds.add(edgeId);
                    edges.push(this.createEdge(
                      edgeId, callerId, targetId, 'calls', 'behavior',
                      { line: call.line, callType: 'instance', language: 'solidity' }
                    ));
                  }
                }
                continue;
              }
            }
            for (const libName of contract.usingLibs) {
              const lib = contractByName.get(libName);
              if (!lib || lib.contract.kind !== 'library') continue;
              const target = lib.contract.functions.find(f => f.name === call.name);
              if (!target) continue;
              const targetContractId = this.contractId(lib.info.relativePath, lib.contract.name);
              const targetId = this.functionId(targetContractId, target.name, target.lineStart);
              if (targetId === callerId || seenTargets.has(targetId)) break;
              seenTargets.add(targetId);
              const edgeId = `call_${callerId}_to_${targetId}`;
              if (edgeIds.has(edgeId)) break;
              edgeIds.add(edgeId);
              edges.push(this.createEdge(
                edgeId, callerId, targetId, 'calls', 'behavior',
                { line: call.line, callType: 'library', language: 'solidity' }
              ));
              break; // first matching using-for library wins
            }
          }
        }
      }
    }
  }

  /** Resolve a called function name within a contract, then transitively through
   *  its base contracts (depth-first, cycle-guarded). Returns the defining
   *  contract + its file so the edge can target the inherited declaration. */
  private resolveFunctionInChain(
    contractByName: Map<string, { info: SolFileInfo; contract: SolContract }>,
    contract: SolContract,
    info: SolFileInfo,
    name: string,
    visited: Set<string>
  ): { info: SolFileInfo; contract: SolContract; fn: SolFunction } | undefined {
    if (visited.has(contract.name)) return undefined;
    visited.add(contract.name);
    const own = contract.functions.find(f => f.name === name);
    if (own) return { info, contract, fn: own };
    for (const base of contract.bases) {
      const entry = contractByName.get(base);
      if (!entry) continue;
      const found = this.resolveFunctionInChain(contractByName, entry.contract, entry.info, name, visited);
      if (found) return found;
    }
    return undefined;
  }

  private emitImportEdges(
    fileInfos: SolFileInfo[],
    projectPath: string,
    fileById: Map<string, SolFileInfo>,
    edges: CASEdge[]
  ): void {
    const edgeIds = new Set(edges.map(e => e.id));
    for (const info of fileInfos) {
      const sourceDir = path.dirname(info.fullPath);
      for (const imp of info.imports) {
        const resolved = this.resolveImportPath(imp.rawPath, sourceDir, projectPath);
        if (!resolved) continue;
        const target = fileById.get(this.normalize(resolved));
        if (!target) continue;
        const sourceId = this.fileId(info.relativePath);
        const targetId = this.fileId(target.relativePath);
        if (sourceId === targetId) continue;
        const edgeId = `${sourceId}_imports_${targetId}_${imp.lineNumber}`;
        if (edgeIds.has(edgeId)) continue;
        edgeIds.add(edgeId);
        edges.push(this.createEdge(
          edgeId, sourceId, targetId, 'imports', 'dependency',
          { line: imp.lineNumber, rawPath: imp.rawPath, language: 'solidity' }
        ));
      }
    }
  }

  private resolveImportPath(rawPath: string, sourceDir: string, projectPath: string): string | undefined {
    // Only resolve relative imports within the repo; node_modules / remappings are skipped.
    if (!rawPath.startsWith('.') && !rawPath.startsWith('/')) return undefined;
    const abs = path.isAbsolute(rawPath) ? rawPath : path.resolve(sourceDir, rawPath);
    const rel = path.relative(projectPath, abs);
    if (rel.startsWith('..')) return undefined;
    return rel;
  }

  // ---- Helpers -------------------------------------------------------------

  private findBlockEnd(lines: string[], startIndex: number): number {
    let depth = 0;
    let seenOpen = false;
    for (let i = startIndex; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '{') { depth++; seenOpen = true; }
        else if (ch === '}') { depth--; if (seenOpen && depth <= 0) return i + 1; }
      }
    }
    return lines.length;
  }

  private findOpenBraceLine(lines: string[], startIndex: number): number {
    for (let i = startIndex; i < lines.length; i++) {
      if (lines[i].includes('{')) return i;
      if (lines[i].includes(';')) return -1;
    }
    return -1;
  }

  // Strip // line comments and /* */ block comments (preserve line count).
  private stripComments(content: string): string {
    let result = '';
    let inLine = false, inBlock = false, inStr = false, strCh = '';
    for (let i = 0; i < content.length; i++) {
      const ch = content[i];
      const next = content[i + 1];
      if (inLine) {
        if (ch === '\n') { inLine = false; result += ch; }
        continue;
      }
      if (inBlock) {
        if (ch === '*' && next === '/') { inBlock = false; i++; }
        else if (ch === '\n') result += ch;
        continue;
      }
      if (inStr) {
        if (ch === strCh) inStr = false;
        result += ch;
        continue;
      }
      if (ch === '"' || ch === "'") { inStr = true; strCh = ch; result += ch; continue; }
      if (ch === '/' && next === '/') { inLine = true; i++; continue; }
      if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
      result += ch;
    }
    return result;
  }

  private normalize(p: string): string {
    return p.replace(/\\/g, '/');
  }

  private fileId(relativePath: string): string {
    return `file_${this.sanitizeId(relativePath)}`;
  }

  private contractId(relativePath: string, name: string): string {
    return `contract_${this.sanitizeId(relativePath)}_${this.sanitizeId(name)}`;
  }

  private functionId(contractId: string, name: string, line: number): string {
    return `function_${contractId}_${this.sanitizeId(name)}_${line}`;
  }

  private extractCommentsFromFile(content: string, filePath: string): CASComment[] {
    const comments: CASComment[] = [];
    const lines = content.split('\n');
    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (inBlock) {
        const text = line.replace(/\*\/.*$/, '').replace(/^\s*\*?/, '').trim();
        if (text) comments.push(this.makeComment('multi-line', '/* */', text, filePath, i + 1));
        if (line.includes('*/')) inBlock = false;
        continue;
      }
      const lineCommentIdx = this.lineCommentIndex(line);
      if (lineCommentIdx !== -1) {
        const text = line.slice(lineCommentIdx + 2).trim();
        if (text) comments.push(this.makeComment('single-line', '//', text, filePath, i + 1));
        continue;
      }
      const blockStart = line.indexOf('/*');
      if (blockStart !== -1) {
        const after = line.slice(blockStart + 2);
        const closeIdx = after.indexOf('*/');
        const text = (closeIdx === -1 ? after : after.slice(0, closeIdx)).replace(/^\s*\*?/, '').trim();
        if (text) comments.push(this.makeComment('multi-line', '/* */', text, filePath, i + 1));
        if (closeIdx === -1) inBlock = true;
      }
    }
    return comments;
  }

  private lineCommentIndex(line: string): number {
    let inStr = false, strCh = '';
    for (let i = 0; i < line.length - 1; i++) {
      const ch = line[i];
      if (inStr) { if (ch === strCh) inStr = false; continue; }
      if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
      if (ch === '/' && line[i + 1] === '/') return i;
    }
    return -1;
  }

  private makeComment(
    type: CASComment['type'], style: CASComment['style'], text: string, filePath: string, line: number
  ): CASComment {
    return {
      // Stable order-independent id: extractCommentsFromFile emits at most one
      // comment per source line, so file+line identifies the comment regardless
      // of file visit order (ids derive from facts, not run-order counters).
      id: `comment_${filePath}_${line}`,
      type,
      style,
      text,
      purpose: this.classifyCommentPurpose(text),
      location: { file: filePath, line, relative_to: 'inline' },
      markers: this.extractCommentMarkers(text)
    };
  }

  private classifyCommentPurpose(text: string): CASComment['purpose'] {
    const lower = text.toLowerCase();
    if (/\b(todo|fixme|hack|xxx|optimize|refactor)\b/.test(lower)) return 'todo';
    if (/\b(warning|warn|caution|danger|important)\b/.test(lower)) return 'warning';
    if (/\b(note|info|tip|hint|dev|notice)\b/.test(lower)) return 'note';
    return 'explanation';
  }

  private extractCommentMarkers(text: string): CASComment['markers'] {
    const lower = text.toLowerCase();
    return {
      is_todo: /\btodo\b/.test(lower),
      is_fixme: /\bfixme\b/.test(lower),
      is_hack: /\bhack\b/.test(lower),
      is_warning: /\b(warning|warn)\b/.test(lower),
      is_note: /\b(note|info|notice)\b/.test(lower),
      is_important: /\b(important|critical|urgent)\b/.test(lower),
      is_deprecated: /\b(deprecated|obsolete)\b/.test(lower),
    };
  }

  private extractTodosFromComments(comments: CASComment[], context: string): CASTodo[] {
    const todos: CASTodo[] = [];
    let todoSeq = 0;
    for (const comment of comments) {
      if (comment.markers?.is_todo || comment.markers?.is_fixme || comment.markers?.is_hack) {
        const typeMatch = comment.text.match(/\b(TODO|FIXME|HACK|NOTE|WARNING|XXX|OPTIMIZE|REFACTOR)\b/i);
        const type = typeMatch ? (typeMatch[0].toUpperCase() as CASTodo['type']) : 'TODO';
        const priority = comment.markers?.is_important ? 'high' :
          comment.markers?.is_fixme ? 'medium' : 'low';
        todos.push({
          id: `todo_${comment.location.file}_${comment.location.line}_${++todoSeq}`,
          type,
          text: comment.text,
          priority,
          category: 'general',
          location: { file: comment.location.file, line: comment.location.line, context },
          metadata: { source: 'comment', comment_type: comment.type }
        });
      }
    }
    return todos;
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'File/Module';
      case 2: return 'Contract';
      case 3: return 'Group';
      case 4: return 'Function/Member';
      case 5: return 'Statement';
      default: return `level_${level}`;
    }
  }

  protected getCapabilities(): string[] {
    return [
      'solidity-contracts',
      'solidity-inheritance',
      'solidity-events',
      'solidity-external-calls',
      'solidity-state-variables',
      'solidity-imports',
      'solidity-entry-points'
    ];
  }
}
