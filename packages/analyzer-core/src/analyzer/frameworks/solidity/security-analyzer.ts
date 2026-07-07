import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, FileAnalysisResult
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import { parseWasm, hasWasmGrammar } from '../../core/wasm-tree-sitter';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';
import * as path from 'path';

/**
 * Solidity security-facts framework analyzer.
 *
 * Grounded on the real vendored tree-sitter-solidity AST:
 *
 *   contract_declaration
 *     identifier <contract name>
 *     inheritance_specifier* -> user_defined_type -> identifier <base name>
 *     contract_body -> function_definition*
 *       identifier <fn name>
 *       visibility <public|external|internal|private>
 *       modifier_invocation -> identifier <modifier name>   (onlyOwner, nonReentrant, ...)
 *       function_body -> ...
 *         member_expression -> member_expression(msg,sender) . identifier(call|transfer|send)
 *           (a `.call{...}(...)`, `.transfer(...)`, `.send(...)` low-level call --
 *            an external-call site whose value/control leaves the contract)
 *         assignment_expression / augmented_assignment_expression
 *           (state write -- LHS is a bare `identifier` or an `array_access`
 *            chain rooted at one, resolved against the contract's declared
 *            state_variable_declaration names)
 *
 * Detected facts (each becomes one `security-fact` CAS node):
 *   - access-control:onlyOwner:<function>    -- function gated by onlyOwner.
 *   - access-control:inherits:<contract>     -- contract inherits Ownable/AccessControl.
 *   - erc20-conformance / erc721-conformance / erc1155-conformance -- contract
 *     declares the full required function set for the standard.
 *   - reentrancy-guard:<function>            -- function gated by nonReentrant.
 *   - external-call-before-state-write:<function> -- function makes a low-level
 *     external call (`.call`/`.transfer`/`.send`) and THEN writes to a state
 *     variable afterward (checks-effects-interactions violation).
 *
 * Fact ids are stable strings so the bench can score F1 by exact string match
 * against truth.json.
 */

const SOL_EXTENSIONS = ['**/*.sol'];

const ERC20_REQUIRED = ['transfer', 'approve', 'transferFrom', 'balanceOf', 'totalSupply', 'allowance'];
const ERC721_REQUIRED = ['balanceOf', 'ownerOf', 'safeTransferFrom', 'transferFrom', 'approve', 'getApproved', 'setApprovalForAll', 'isApprovedForAll'];
const ERC1155_REQUIRED = ['balanceOf', 'balanceOfBatch', 'setApprovalForAll', 'isApprovedForAll', 'safeTransferFrom', 'safeBatchTransferFrom'];

const OWNERSHIP_BASE_NAMES = new Set(['Ownable', 'Ownable2Step', 'AccessControl', 'AccessControlEnumerable']);
const EXTERNAL_CALL_MEMBERS = new Set(['call', 'delegatecall', 'staticcall', 'transfer', 'send']);

interface SolFunctionFact {
  name: string;
  lineStart: number;
  lineEnd: number;
  visibility?: string;
  modifiers: string[];
  externalCalls: Array<{ member: string; line: number }>;
  stateWrites: Array<{ variable: string; line: number }>;
}

interface SolContractFact {
  name: string;
  lineStart: number;
  lineEnd: number;
  bases: string[];
  stateVarNames: Set<string>;
  functions: SolFunctionFact[];
}

interface SolFileFact {
  relativePath: string;
  fullPath: string;
  contracts: SolContractFact[];
}

export class SoliditySecurityAnalyzer extends BaseAnalyzer {
  constructor() {
    super('solidity-security', 'Solidity Security Facts Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const files = await glob(SOL_EXTENSIONS, {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
        nodir: true,
      });
      return files.length > 0;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return false;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await glob(SOL_EXTENSIONS, {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
      nodir: true,
    });
    return files.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    const fileFact = await this.parseSolidityFile(context.relativePath, context.filePath, content);
    if (fileFact) this.emitFacts(fileFact, nodes, edges);

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      [],
      nodes.map(n => n.name)
    );
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    this.resetAnalysisWarnings();
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      let solFiles = await glob(SOL_EXTENSIONS, {
        cwd: context.projectPath,
        ignore: this.getIgnorePatterns(context),
        nodir: true,
      });
      solFiles.sort();
      solFiles = this.capAndPrioritizeSourceFiles(solFiles, 'solidity security files');

      let factCount = 0;
      for (const relativePath of solFiles) {
        const fullPath = path.join(context.projectPath, relativePath);
        let content = '';
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }
        const fileFact = await this.parseSolidityFile(relativePath, fullPath, content);
        if (!fileFact) continue;
        factCount += this.emitFacts(fileFact, nodes, edges);
      }

      const warnings = this.collectAnalysisWarnings();
      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        ...(warnings.length > 0 ? { warnings } : {}),
        framework: 'solidity-security',
        framework_specific: {
          framework: 'solidity-security',
          filesAnalyzed: solFiles.length,
          securityFacts: factCount,
        },
      });
    } catch (error) {
      throw new AnalyzerError(
        `Solidity security analysis failed: ${(error as Error).message}`,
        'SOLIDITY_SECURITY_ANALYSIS_ERROR'
      );
    }
  }

  private async parseSolidityFile(
    relativePath: string,
    fullPath: string,
    content: string
  ): Promise<SolFileFact | undefined> {
    if (!hasWasmGrammar('solidity')) {
      this.addAnalysisWarning('solidity wasm grammar unavailable; skipping security-facts analysis');
      return undefined;
    }
    let tree: any;
    try {
      tree = await parseWasm('solidity', content);
    } catch (e) {
      this.addAnalysisWarning(`solidity parse failed for ${relativePath}: ${(e as Error).message}`);
      return undefined;
    }

    const contracts: SolContractFact[] = [];
    const root = tree.rootNode;
    for (let i = 0; i < root.childCount; i++) {
      const node = root.child(i);
      if (node.type === 'contract_declaration') {
        contracts.push(this.parseContract(node));
      }
    }

    return { relativePath, fullPath, contracts };
  }

  private parseContract(contractNode: any): SolContractFact {
    let name = '';
    const bases: string[] = [];
    let body: any;

    for (let i = 0; i < contractNode.childCount; i++) {
      const child = contractNode.child(i);
      if (child.type === 'identifier' && !name) {
        name = child.text;
      } else if (child.type === 'inheritance_specifier') {
        const baseName = this.findDescendantText(child, 'identifier');
        if (baseName) bases.push(baseName);
      } else if (child.type === 'contract_body') {
        body = child;
      }
    }

    const lineStart = contractNode.startPosition.row + 1;
    const lineEnd = contractNode.endPosition.row + 1;

    const stateVarNames = new Set<string>();
    const functions: SolFunctionFact[] = [];

    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        const child = body.child(i);
        if (child.type === 'state_variable_declaration') {
          const varName = this.lastDescendantText(child, 'identifier');
          if (varName) stateVarNames.add(varName);
        }
      }
      for (let i = 0; i < body.childCount; i++) {
        const child = body.child(i);
        if (child.type === 'function_definition') {
          functions.push(this.parseFunction(child, stateVarNames));
        }
      }
    }

    return { name, lineStart, lineEnd, bases, stateVarNames, functions };
  }

  private parseFunction(fnNode: any, stateVarNames: Set<string>): SolFunctionFact {
    let name = '';
    let visibility: string | undefined;
    const modifiers: string[] = [];
    let body: any;
    let sawIdentifier = false;

    for (let i = 0; i < fnNode.childCount; i++) {
      const child = fnNode.child(i);
      if (child.type === 'identifier' && !sawIdentifier) {
        name = child.text;
        sawIdentifier = true;
      } else if (child.type === 'visibility') {
        visibility = child.text;
      } else if (child.type === 'modifier_invocation') {
        const modName = this.findDescendantText(child, 'identifier');
        if (modName) modifiers.push(modName);
      } else if (child.type === 'function_body') {
        body = child;
      }
    }

    const lineStart = fnNode.startPosition.row + 1;
    const lineEnd = fnNode.endPosition.row + 1;

    const externalCalls: Array<{ member: string; line: number }> = [];
    const stateWrites: Array<{ variable: string; line: number }> = [];

    if (body) {
      this.walkBody(body, stateVarNames, externalCalls, stateWrites);
    }

    return { name, lineStart, lineEnd, visibility, modifiers, externalCalls, stateWrites };
  }

  private walkBody(
    node: any,
    stateVarNames: Set<string>,
    externalCalls: Array<{ member: string; line: number }>,
    stateWrites: Array<{ variable: string; line: number }>
  ): void {
    if (node.type === 'member_expression') {
      const members = this.memberChainNames(node);
      const last = members[members.length - 1];
      if (last && EXTERNAL_CALL_MEMBERS.has(last)) {
        externalCalls.push({ member: last, line: node.startPosition.row + 1 });
      }
    }

    if (node.type === 'assignment_expression' || node.type === 'augmented_assignment_expression') {
      const lhs = node.child(0);
      const rootName = lhs ? this.arrayAccessRootIdentifier(lhs) : undefined;
      if (rootName && stateVarNames.has(rootName)) {
        stateWrites.push({ variable: rootName, line: node.startPosition.row + 1 });
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      this.walkBody(node.child(i), stateVarNames, externalCalls, stateWrites);
    }
  }

  private memberChainNames(node: any): string[] {
    const names: string[] = [];
    const collect = (n: any): void => {
      if (n.type === 'member_expression') {
        collect(n.child(0));
        const last = n.child(n.childCount - 1);
        if (last && last.type === 'identifier') names.push(last.text);
      } else if (n.type === 'identifier') {
        names.push(n.text);
      }
    };
    collect(node);
    return names;
  }

  private arrayAccessRootIdentifier(node: any): string | undefined {
    let cur = node;
    while (cur && cur.type === 'array_access') {
      cur = cur.child(0);
    }
    return cur && cur.type === 'identifier' ? cur.text : undefined;
  }

  private findDescendantText(node: any, type: string): string | undefined {
    if (node.type === type) return node.text;
    for (let i = 0; i < node.childCount; i++) {
      const found = this.findDescendantText(node.child(i), type);
      if (found) return found;
    }
    return undefined;
  }

  private lastDescendantText(node: any, type: string): string | undefined {
    let result: string | undefined;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === type) result = child.text;
      else {
        const nested = this.lastDescendantText(child, type);
        if (nested) result = nested;
      }
    }
    return result;
  }

  private emitFacts(fileFact: SolFileFact, nodes: CASNode[], edges: CASEdge[]): number {
    let count = 0;
    for (const contract of fileFact.contracts) {
      for (const fn of contract.functions) {
        if (fn.modifiers.includes('onlyOwner')) {
          const factId = `access-control:onlyOwner:${fn.name}`;
          nodes.push(this.buildFactNode(
            factId, 'access-control', fileFact, contract, fn,
            `Function ${contract.name}.${fn.name} is gated by onlyOwner (access control)`,
            { modifier: 'onlyOwner', mechanism: 'modifier' }
          ));
          count++;
        }
      }

      const ownershipBase = contract.bases.find(b => OWNERSHIP_BASE_NAMES.has(b));
      if (ownershipBase) {
        const factId = `access-control:inherits:${contract.name}`;
        nodes.push(this.buildContractFactNode(
          factId, 'access-control', fileFact, contract,
          `Contract ${contract.name} inherits ${ownershipBase} (access control via inheritance)`,
          { base: ownershipBase, mechanism: 'inheritance' }
        ));
        count++;
      }

      for (const fn of contract.functions) {
        if (fn.modifiers.includes('nonReentrant')) {
          const factId = `reentrancy-guard:${fn.name}`;
          nodes.push(this.buildFactNode(
            factId, 'reentrancy-guard', fileFact, contract, fn,
            `Function ${contract.name}.${fn.name} is guarded against reentrancy by nonReentrant`,
            { modifier: 'nonReentrant', mechanism: 'modifier' }
          ));
          count++;
        }
      }

      const fnNames = new Set(contract.functions.map(f => f.name));
      if (ERC20_REQUIRED.every(req => fnNames.has(req))) {
        nodes.push(this.buildContractFactNode(
          'erc20-conformance', 'erc-conformance', fileFact, contract,
          `Contract ${contract.name} implements the full ERC20 function set`,
          { standard: 'ERC20', required: ERC20_REQUIRED }
        ));
        count++;
      }
      if (ERC721_REQUIRED.every(req => fnNames.has(req))) {
        nodes.push(this.buildContractFactNode(
          'erc721-conformance', 'erc-conformance', fileFact, contract,
          `Contract ${contract.name} implements the full ERC721 function set`,
          { standard: 'ERC721', required: ERC721_REQUIRED }
        ));
        count++;
      }
      if (ERC1155_REQUIRED.every(req => fnNames.has(req))) {
        nodes.push(this.buildContractFactNode(
          'erc1155-conformance', 'erc-conformance', fileFact, contract,
          `Contract ${contract.name} implements the full ERC1155 function set`,
          { standard: 'ERC1155', required: ERC1155_REQUIRED }
        ));
        count++;
      }

      for (const fn of contract.functions) {
        if (fn.externalCalls.length === 0 || fn.stateWrites.length === 0) continue;
        const firstCallLine = Math.min(...fn.externalCalls.map(c => c.line));
        const laterWrite = fn.stateWrites.find(w => w.line > firstCallLine);
        if (!laterWrite) continue;
        const factId = `external-call-before-state-write:${fn.name}`;
        nodes.push(this.buildFactNode(
          factId, 'cei-violation', fileFact, contract, fn,
          `Function ${contract.name}.${fn.name} makes an external call (line ${firstCallLine}) `
          + `then writes state variable "${laterWrite.variable}" afterward (line ${laterWrite.line}) `
          + `-- checks-effects-interactions violation, reentrancy risk`,
          {
            violation: 'checks-effects-interactions',
            external_call_line: firstCallLine,
            state_write_line: laterWrite.line,
            state_variable: laterWrite.variable,
          },
          { protected: false }
        ));
        count++;
      }
    }
    return count;
  }

  private buildFactNode(
    factId: string,
    factKind: string,
    fileFact: SolFileFact,
    contract: SolContractFact,
    fn: SolFunctionFact,
    description: string,
    attributes: Record<string, any>,
    security?: CASNode['security']
  ): CASNode {
    const nodeId = this.factNodeId(fileFact.relativePath, contract.name, factId);
    const builder = this.createNodeBuilder(nodeId, factId, 'security-fact')
      .withLevel(4, 'security-facts')
      .withCategory('security', ['solidity-security', factKind])
      .withSource({ file: fileFact.fullPath, line: fn.lineStart, end_line: fn.lineEnd })
      .withDescription(description)
      .withMetadata({
        framework: 'solidity-security',
        attributes: {
          fact_kind: factKind,
          contract: contract.name,
          function: fn.name,
          file: fileFact.relativePath,
          ...attributes,
        },
      })
      .withTags(['solidity-security-fact', `security-fact:${factKind}`]);
    const node = builder.build();
    if (security) node.security = security;
    return node;
  }

  private buildContractFactNode(
    factId: string,
    factKind: string,
    fileFact: SolFileFact,
    contract: SolContractFact,
    description: string,
    attributes: Record<string, any>
  ): CASNode {
    const nodeId = this.factNodeId(fileFact.relativePath, contract.name, factId);
    return this.createNodeBuilder(nodeId, factId, 'security-fact')
      .withLevel(2, 'security-facts')
      .withCategory('security', ['solidity-security', factKind])
      .withSource({ file: fileFact.fullPath, line: contract.lineStart, end_line: contract.lineEnd })
      .withDescription(description)
      .withMetadata({
        framework: 'solidity-security',
        attributes: {
          fact_kind: factKind,
          contract: contract.name,
          file: fileFact.relativePath,
          ...attributes,
        },
      })
      .withTags(['solidity-security-fact', `security-fact:${factKind}`])
      .build();
  }

  private factNodeId(relativePath: string, contractName: string, factId: string): string {
    return `solsec_fact_${this.sanitizeId(relativePath)}_${this.sanitizeId(contractName)}_${this.sanitizeId(factId)}`;
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 2: return 'security-facts';
      case 4: return 'security-facts';
      default: return `solidity-security-level-${level}`;
    }
  }

  protected getCapabilities(): string[] {
    return [
      'solidity-access-control',
      'solidity-erc-conformance',
      'solidity-reentrancy-guard',
      'solidity-cei-violations',
    ];
  }
}

export default { SoliditySecurityAnalyzer };
