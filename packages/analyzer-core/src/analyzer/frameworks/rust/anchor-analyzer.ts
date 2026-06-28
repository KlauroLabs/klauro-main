import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASNode, CASEdge, CASEntryPoint, CASExitPoint } from '../../../types/cas.types';
import { RustAnalyzer } from '../../languages/rust-analyzer';
import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';

/**
 * Anchor framework analyzer (Solana smart contracts, Rust).
 *
 * Anchor programs are Rust, so generic functions/structs are extracted by the base
 * RustAnalyzer. This analyzer adds the Anchor-specific structure that has no other
 * home and is the actual product surface of a Solana program:
 *
 *  - the `#[program]` module is the deployed contract;
 *  - each `pub fn` inside it is a callable INSTRUCTION (the program's real entry points,
 *    analogous to HTTP routes) — these are who-can-call-what;
 *  - `#[derive(Accounts)]` structs are the per-instruction account contexts whose
 *    `#[account(...)]` constraints (signer, init, mut, seeds/PDA) decide authority;
 *  - `#[account]` structs are the on-chain STATE (the program's storage = data entities);
 *  - `#[event]` / `#[error_code]` are the event and error contracts;
 *  - CPIs (`CpiContext`, `invoke`/`invoke_signed`) are cross-program calls = exit points.
 *
 * Without this, an Anchor program looks like an undifferentiated pile of Rust fns and
 * structs, hiding the contract's instructions, authority model, and cross-program edges.
 */
export class AnchorAnalyzer extends BaseAnalyzer {
  private rustAnalyzer: RustAnalyzer;

  constructor() {
    super('anchor', 'Anchor Framework Analyzer', '1.0.0', 'framework');
    this.rustAnalyzer = new RustAnalyzer();
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      if (await fs.pathExists(path.join(projectPath, 'Anchor.toml'))) return true;

      const cargoPath = path.join(projectPath, 'Cargo.toml');
      if (await fs.pathExists(cargoPath)) {
        const cargo = await fs.readFile(cargoPath, 'utf-8');
        if (/\banchor-lang\b/.test(cargo)) return true;
      }

      for (const file of await this.findRustFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8');
        if (/#\[program\]/.test(content) || /use\s+anchor_lang/.test(content)) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const rust = await this.rustAnalyzer.analyze(context);
    const nodes: CASNode[] = [...(rust.nodes || [])];
    const edges: CASEdge[] = [...(rust.edges || [])];
    const entryPoints: CASEntryPoint[] = [...(rust.entry_points || [])];
    const exitPoints: CASExitPoint[] = [...(rust.exit_points || [])];

    let programCount = 0;
    let instructionCount = 0;
    let accountsContextCount = 0;
    let stateAccountCount = 0;
    let eventCount = 0;
    let errorCount = 0;
    let cpiCount = 0;
    let pdaCount = 0;

    try {
      const files = await this.findRustFiles(context.projectPath);
      const sources = await Promise.all(
        files.map(async file => ({
          relativePath: path.relative(context.projectPath, file),
          content: await fs.readFile(file, 'utf-8'),
        }))
      );

      for (const src of sources) {
        const r = this.extractAnchor(src.content, src.relativePath, nodes, edges, entryPoints, exitPoints);
        programCount += r.programs;
        instructionCount += r.instructions;
        accountsContextCount += r.accountsContexts;
        stateAccountCount += r.stateAccounts;
        eventCount += r.events;
        errorCount += r.errors;
        cpiCount += r.cpis;
        pdaCount += r.pdas;
      }

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          framework: 'anchor',
          program_count: programCount,
          instruction_count: instructionCount,
          accounts_context_count: accountsContextCount,
          state_account_count: stateAccountCount,
          event_count: eventCount,
          error_count: errorCount,
          cpi_count: cpiCount,
          pda_count: pdaCount,
        },
      });
    } catch (error) {
      throw new Error(`Anchor analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return [
      'anchor-program',
      'anchor-instructions',
      'anchor-accounts',
      'anchor-state',
      'anchor-cpi',
      'anchor-events',
    ];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'anchor-framework';
      case 2: return 'programs';
      case 3: return 'instructions';
      case 4: return 'accounts-state';
      default: return `anchor-level-${level}`;
    }
  }

  /**
   * Extract Anchor constructs from one Rust source file. Returns per-construct counts.
   * All node/edge/entry/exit collections are mutated in place.
   */
  private extractAnchor(
    content: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[]
  ): {
    programs: number; instructions: number; accountsContexts: number;
    stateAccounts: number; events: number; errors: number; cpis: number; pdas: number;
  } {
    const counts = { programs: 0, instructions: 0, accountsContexts: 0, stateAccounts: 0, events: 0, errors: 0, cpis: 0, pdas: 0 };
    if (!/#\[program\]|#\[account|#\[event\]|#\[error_code\]|#\[derive\(Accounts\)\]|use\s+anchor_lang/.test(content)) {
      return counts;
    }

    const lineForIndex = this.lineIndexer(content);

    // ---- Program module + its instructions ----------------------------------
    // `#[program] pub mod my_program { ... }`
    const programRe = /#\[program\]\s*(?:pub\s+)?mod\s+([A-Za-z_]\w*)\s*\{/g;
    let pm: RegExpExecArray | null;
    while ((pm = programRe.exec(content)) !== null) {
      const programName = pm[1];
      const bodyStart = pm.index + pm[0].length;
      const bodyEnd = this.matchBrace(content, bodyStart - 1);
      const body = content.slice(bodyStart, bodyEnd === -1 ? content.length : bodyEnd);
      const progLine = lineForIndex(pm.index);

      const programNodeId = `anchor:program:${relativePath}:${programName}`;
      nodes.push(this.createNode(
        programNodeId,
        programName,
        'anchor-program',
        2,
        relativePath,
        progLine,
        bodyEnd === -1 ? undefined : lineForIndex(bodyEnd),
        { anchor_kind: 'program', deployed_contract: true }
      ));
      counts.programs++;

      // Each `pub fn name(ctx: Context<Foo>, ...)` inside the program is an instruction.
      const fnRe = /pub\s+fn\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/g;
      let fm: RegExpExecArray | null;
      while ((fm = fnRe.exec(body)) !== null) {
        const instrName = fm[1];
        const params = fm[2];
        const ctxMatch = params.match(/Context\s*<\s*([A-Za-z_]\w*)/);
        const contextType = ctxMatch ? ctxMatch[1] : undefined;
        const absIndex = bodyStart + fm.index;
        const fnLine = lineForIndex(absIndex);

        const instrNodeId = `anchor:instruction:${relativePath}:${programName}:${instrName}`;
        nodes.push(this.createNode(
          instrNodeId,
          instrName,
          'anchor-instruction',
          3,
          relativePath,
          fnLine,
          undefined,
          { anchor_kind: 'instruction', program: programName, context_type: contextType }
        ));
        counts.instructions++;

        // contains edge program -> instruction
        edges.push(this.createEdge(
          `anchor:contains:${programNodeId}:${instrNodeId}`,
          programNodeId,
          instrNodeId,
          'contains',
          'structure',
          { anchor: true }
        ));

        // instruction is a callable entry point (like an HTTP route)
        entryPoints.push(this.createEntryPoint(
          `entry:anchor:${relativePath}:${programName}:${instrName}`,
          instrNodeId,
          'message',
          `instruction ${instrName}`,
          `Anchor instruction ${instrName} on program ${programName}`,
          { pattern: instrName },
          undefined,
          {
            framework: 'anchor',
            anchor_kind: 'instruction',
            program: programName,
            instruction: instrName,
            context_type: contextType,
          },
          { node_id: instrNodeId, method_name: instrName, file: relativePath, line: fnLine }
        ));

        // Link instruction -> its Accounts context (resolved after contexts exist below
        // via a deferred edge keyed on the context type's node id).
        if (contextType) {
          const ctxNodeId = `anchor:accounts:${relativePath}:${contextType}`;
          edges.push(this.createEdge(
            `anchor:uses-accounts:${instrNodeId}:${ctxNodeId}`,
            instrNodeId,
            ctxNodeId,
            'uses-accounts',
            'anchor',
            { anchor: true, context_type: contextType }
          ));
        }
      }
    }

    // ---- Accounts contexts: #[derive(Accounts)] pub struct Foo<'info> { ... } ----
    const accountsRe = /#\[derive\(([^)]*\bAccounts\b[^)]*)\)\]\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\{/g;
    let am: RegExpExecArray | null;
    while ((am = accountsRe.exec(content)) !== null) {
      const structName = am[2];
      const bodyStart = am.index + am[0].length;
      const bodyEnd = this.matchBrace(content, bodyStart - 1);
      const fieldsBody = content.slice(bodyStart, bodyEnd === -1 ? content.length : bodyEnd);
      const structLine = lineForIndex(am.index);

      const ctxNodeId = `anchor:accounts:${relativePath}:${structName}`;
      nodes.push(this.createNode(
        ctxNodeId,
        structName,
        'anchor-accounts',
        4,
        relativePath,
        structLine,
        bodyEnd === -1 ? undefined : lineForIndex(bodyEnd),
        { anchor_kind: 'accounts-context' }
      ));
      counts.accountsContexts++;

      // Parse each account field: optional #[account(...)] attr then `pub name: Type`.
      const fieldRe = /(?:#\[account\(([^\]]*)\)\]\s*)?(?:pub\s+)?([A-Za-z_]\w*)\s*:\s*([^,\n}]+)/g;
      let fdm: RegExpExecArray | null;
      while ((fdm = fieldRe.exec(fieldsBody)) !== null) {
        const constraints = (fdm[1] || '').trim();
        const fieldName = fdm[2];
        const fieldType = fdm[3].trim().replace(/,$/, '');
        // Only treat it as an account field if the type looks like an Anchor account wrapper.
        const accKind = /\bSigner\b/.test(fieldType) ? 'signer'
          : /\bProgram\b/.test(fieldType) ? 'program'
          : /\bAccount\b|\bAccountInfo\b|\bUncheckedAccount\b|\bSystemAccount\b|\bSysvar\b/.test(fieldType) ? 'account'
          : null;
        if (!accKind && !constraints) continue;
        if (!accKind) continue;

        const isInit = /\binit\b/.test(constraints);
        const isMut = /\bmut\b/.test(constraints);
        const hasSeeds = /\bseeds\s*=/.test(constraints);
        if (hasSeeds) counts.pdas++;
        const fieldLine = lineForIndex(bodyStart + fdm.index);

        const fieldNodeId = `anchor:account-ref:${relativePath}:${structName}:${fieldName}`;
        nodes.push(this.createNode(
          fieldNodeId,
          fieldName,
          'anchor-account-ref',
          4,
          relativePath,
          fieldLine,
          undefined,
          {
            anchor_kind: 'account-ref',
            account_role: accKind,
            account_type: fieldType,
            context: structName,
            is_signer: accKind === 'signer',
            is_init: isInit,
            is_mut: isMut,
            is_pda: hasSeeds,
            constraints: constraints || undefined,
          }
        ));
        edges.push(this.createEdge(
          `anchor:has-account:${ctxNodeId}:${fieldNodeId}`,
          ctxNodeId,
          fieldNodeId,
          'has-account',
          'anchor',
          { account_role: accKind, is_pda: hasSeeds }
        ));
      }
    }

    // ---- State accounts: #[account] pub struct State { ... } => data entity --------
    // `#[account]` NOT followed by `(` (that would be a constraint), preceding a struct.
    const stateRe = /#\[account\]\s*(?:#\[[^\]]*\]\s*)*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/g;
    let sm: RegExpExecArray | null;
    while ((sm = stateRe.exec(content)) !== null) {
      const stateName = sm[1];
      const stateLine = lineForIndex(sm.index);
      const stateNodeId = `anchor:state:${relativePath}:${stateName}`;
      nodes.push(this.createNode(
        stateNodeId,
        stateName,
        'data-entity',
        4,
        relativePath,
        stateLine,
        undefined,
        { anchor_kind: 'state-account', on_chain: true, storage: true }
      ));
      counts.stateAccounts++;
    }

    // ---- Events: #[event] pub struct X --------------------------------------------
    const eventRe = /#\[event\]\s*(?:#\[[^\]]*\]\s*)*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/g;
    let em: RegExpExecArray | null;
    while ((em = eventRe.exec(content)) !== null) {
      const eventName = em[1];
      const eventLine = lineForIndex(em.index);
      nodes.push(this.createNode(
        `anchor:event:${relativePath}:${eventName}`,
        eventName,
        'anchor-event',
        4,
        relativePath,
        eventLine,
        undefined,
        { anchor_kind: 'event' }
      ));
      counts.events++;
    }

    // ---- Errors: #[error_code] enum X ---------------------------------------------
    const errorRe = /#\[error_code\]\s*(?:#\[[^\]]*\]\s*)*(?:pub\s+)?enum\s+([A-Za-z_]\w*)/g;
    let erm: RegExpExecArray | null;
    while ((erm = errorRe.exec(content)) !== null) {
      const errName = erm[1];
      const errLine = lineForIndex(erm.index);
      nodes.push(this.createNode(
        `anchor:error:${relativePath}:${errName}`,
        errName,
        'error-contract',
        4,
        relativePath,
        errLine,
        undefined,
        { anchor_kind: 'error-code' }
      ));
      counts.errors++;
    }

    // ---- CPIs: cross-program invocations => exit points ----------------------------
    const cpiRe = /\b(CpiContext\s*::\s*new(?:_with_signer)?|invoke_signed|invoke)\s*\(/g;
    let cm: RegExpExecArray | null;
    const cpiSeen = new Set<string>();
    while ((cm = cpiRe.exec(content)) !== null) {
      const kind = cm[1].includes('CpiContext') ? 'cpi_context'
        : cm[1] === 'invoke_signed' ? 'invoke_signed' : 'invoke';
      const cpiLine = lineForIndex(cm.index);
      const dedupe = `${kind}:${cpiLine}`;
      if (cpiSeen.has(dedupe)) continue;
      cpiSeen.add(dedupe);
      exitPoints.push(this.createExitPoint(
        `exit:anchor:cpi:${relativePath}:${cpiLine}:${kind}`,
        `anchor:cpi:${relativePath}:${cpiLine}`,
        'api',
        `CPI ${kind}`,
        `Cross-program invocation (${kind}) to another Solana program`,
        { resource: 'solana-program' },
        { action: 'cross-program-invoke', method: kind },
        { framework: 'anchor', anchor_kind: 'cpi', cpi_kind: kind, file: relativePath, line: cpiLine }
      ));
      counts.cpis++;
    }

    return counts;
  }

  /** Build a fast line-number lookup for byte offsets in `content`. */
  private lineIndexer(content: string): (index: number) => number {
    const lineStartOffsets: number[] = [];
    let offset = 0;
    for (const line of content.split('\n')) {
      lineStartOffsets.push(offset);
      offset += line.length + 1;
    }
    return (index: number): number => {
      let low = 0, high = lineStartOffsets.length - 1, result = 0;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (lineStartOffsets[mid] <= index) { result = mid; low = mid + 1; } else { high = mid - 1; }
      }
      return result + 1;
    };
  }

  /**
   * Given the index of an opening `{` (or the char just before the body), return the
   * index of the matching closing `}`. Returns -1 if unbalanced.
   */
  private matchBrace(content: string, openBraceIndex: number): number {
    let i = openBraceIndex;
    // Find the actual opening brace from the given position.
    while (i < content.length && content[i] !== '{') i++;
    if (i >= content.length) return -1;
    let depth = 0;
    for (; i < content.length; i++) {
      const ch = content[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  private async findRustFiles(projectPath: string): Promise<string[]> {
    const files = await glob('**/*.rs', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    return files.map(file => path.join(projectPath, file));
  }
}
