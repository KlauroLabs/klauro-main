import { AnalysisContext, BaseAnalyzer, FileAnalysisContext, FileAnalysisResult } from '../../core/base-analyzer';
import { CASContribution, CASEdge, CASLibrary, CASNode } from '../../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';
import { createYieldBudget } from '../../core/event-loop-yield';

type ValidationLibrary = 'zod' | 'yup' | 'class-validator' | 'joi' | 'ajv' | 'marshmallow' | 'cerberus';

interface ValidationField {
  name: string;
  type: string;
  required?: boolean;
  validators?: string[];






  decoratorArgs?: Record<string, string>;
}

interface ValidationContract {
  id: string;
  name: string;
  variableName: string;
  library: ValidationLibrary;
  kind: string;
  fields: ValidationField[];
  filePath: string;
  line: number;
  endLine?: number;
  evidence: string;
}

interface HandlerUsage {
  id: string;
  name: string;
  filePath: string;
  line: number;
  contractId: string;
  contractName: string;
  evidence: string;
}

interface DependencyHit {
  name: string;
  version?: string;
  type: CASLibrary['type'];
  packageManager: string;
}

const LIBRARY_PACKAGES: Record<ValidationLibrary, string[]> = {
  zod: ['zod'],
  yup: ['yup'],
  'class-validator': ['class-validator'],
  joi: ['joi', '@hapi/joi'],
  ajv: ['ajv'],
  marshmallow: ['marshmallow'],
  cerberus: ['cerberus'],
};

const ALL_PACKAGES = Object.values(LIBRARY_PACKAGES).flat();

export class ValidationSchemaAnalyzer extends BaseAnalyzer {
  constructor() {
    super('validation-schema-contracts', 'Validation Schema Contract Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const dependencies = await this.readDependencies(projectPath);
    if (dependencies.some(dep => ALL_PACKAGES.some(pkg => this.packageMatches(dep.name, pkg)))) {
      return true;
    }

    for (const relativeFile of await this.sourceFiles(projectPath)) {
      const content = await this.safeRead(path.join(projectPath, relativeFile));
      if (content && this.importedLibraries(content).size > 0) return true;
    }
    return false;
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const relevant: string[] = [];
    for (const relativeFile of await this.sourceFiles(projectPath)) {
      const content = await this.safeRead(path.join(projectPath, relativeFile));
      if (content && this.fileMayContainValidation(content)) relevant.push(relativeFile);
    }
    return relevant.sort();
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const { nodes, edges, libraries, contracts, handlerUsages } = await this.analyzeValidationContracts(
      context.projectPath,
      await this.sourceFiles(context),
      true
    );

    const contribution = this.createContribution(nodes, edges, [], [], {
      library_family: 'input-contract-validation',
      analyzer_family: 'validation-serialization-schema-contracts',
      validation_contracts: contracts.length,
      linked_handler_usages: handlerUsages.length,
      libraries_detected: libraries.length,
      categories: ['validation', 'contracts', 'input-validation'],
    });
    contribution.libraries = libraries;
    return contribution;
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const content = await fs.readFile(context.filePath, 'utf8');
    const stat = await fs.stat(context.filePath);
    const { nodes, edges, contracts } = await this.analyzeValidationContracts(
      context.projectPath,
      [context.relativePath],
      false
    );

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      [],
      [],
      this.extractImports(content),
      contracts.map(contract => contract.name)
    );
  }

  protected getCapabilities(): string[] {
    return [
      'input-validation-contract-detection',
      'schema-field-extraction',
      'route-handler-validation-linking',
      'import-gated-validation-library-attribution',
      'json-schema-and-dto-contract-detection',
    ];
  }

  protected getLevelName(level: number): string {
    return level <= 3 ? 'validation contract' : 'validation usage';
  }

  private async analyzeValidationContracts(
    projectPath: string,
    files: string[],
    includeLibraries: boolean
  ): Promise<{
    nodes: CASNode[];
    edges: CASEdge[];
    libraries: CASLibrary[];
    contracts: ValidationContract[];
    handlerUsages: HandlerUsage[];
  }> {
    const dependencies = await this.readDependencies(projectPath);
    const contracts: ValidationContract[] = [];
    const handlerUsages: HandlerUsage[] = [];




    const maybeYield = createYieldBudget();
    for (const relativeFile of files) {
      await maybeYield();
      const absoluteFile = path.join(projectPath, relativeFile);
      const content = await this.safeRead(absoluteFile);
      if (!content || !this.fileMayContainValidation(content)) continue;

      const imported = this.importedLibraries(content);
      if (imported.size === 0) continue;

      const fileContracts = this.extractContracts(content, relativeFile, imported);
      contracts.push(...fileContracts);
      handlerUsages.push(...this.extractHandlerUsages(content, relativeFile, fileContracts));
    }

    const nodes = this.createContractNodes(contracts);
    const handlerNodes = this.createHandlerNodes(handlerUsages);
    nodes.push(...handlerNodes);

    const edges = handlerUsages.map(usage => this.createEdge(
      `validation_contract_edge_${usage.contractId}_${usage.id}`,
      usage.contractId,
      usage.id,
      'validates_input_for',
      'validation',
      {
        confidence: 0.82,
        attributes: {
          contract: usage.contractName,
          boundary_type: 'input-validation',
          evidence: usage.evidence,
        },
        locations: [{ file: usage.filePath, line: usage.line }],
      }
    ));

    const libraries = includeLibraries ? this.createLibraries(dependencies, contracts) : [];
    return { nodes, edges, libraries, contracts, handlerUsages };
  }

  private createContractNodes(contracts: ValidationContract[]): CASNode[] {
    return contracts.map(contract => this.createNode(
      contract.id,
      contract.name,
      'validation_contract',
      3,
      contract.filePath,
      contract.line,
      contract.endLine,
      {
        library: contract.library,
        source: `${contract.library}_schema`,
        schemaKind: contract.kind,
        contract_kind: 'input-validation',
        boundary_type: 'input-validation',
        architecture_category: 'validation-contract',
        fields: contract.fields,
        field_count: contract.fields.length,
        evidence: contract.evidence,
        tags: ['input-validation-contract', 'schema-contract', contract.library],
        subcategories: ['validation', 'schema', 'contract', 'input-validation', contract.library],
        attributes: {
          library: contract.library,
          variable: contract.variableName,
          fields: contract.fields,
          boundary_type: 'input-validation',
        },
      }
    ));
  }

  private createHandlerNodes(usages: HandlerUsage[]): CASNode[] {
    const byId = new Map<string, HandlerUsage>();
    for (const usage of usages) byId.set(usage.id, usage);
    return [...byId.values()].map(usage => this.createNode(
      usage.id,
      usage.name,
      'handler',
      4,
      usage.filePath,
      usage.line,
      usage.line,
      {
        source: 'validation_schema_usage',
        contract: usage.contractName,
        evidence: usage.evidence,
        tags: ['validation-handler-link'],
        subcategories: ['handler', 'route-handler', 'input-validation'],
      }
    ));
  }

  private createLibraries(dependencies: DependencyHit[], contracts: ValidationContract[]): CASLibrary[] {
    const libraries: CASLibrary[] = [];
    const contractCounts = new Map<ValidationLibrary, number>();
    for (const contract of contracts) {
      contractCounts.set(contract.library, (contractCounts.get(contract.library) || 0) + 1);
    }

    for (const [library, packages] of Object.entries(LIBRARY_PACKAGES) as Array<[ValidationLibrary, string[]]>) {
      const hits = dependencies.filter(dep => packages.some(pkg => this.packageMatches(dep.name, pkg)));
      for (const hit of hits) {
        libraries.push({
          id: `lib_${this.sanitizeId(hit.name)}`,
          name: hit.name,
          version: hit.version,
          type: hit.type,
          package_manager: hit.packageManager,
          category: 'validation',
          description: `${hit.name} defines input validation and serialization schema contracts.`,
          usage_statistics: {
            import_count: contractCounts.get(library) || 0,
            usage_frequency: (contractCounts.get(library) || 0) > 3 ? 'medium' : (contractCounts.get(library) || 0) > 0 ? 'low' : 'declared-only',
            critical_path: true,
          },
          connected_nodes: contracts.filter(contract => contract.library === library).map(contract => contract.id),
          metadata: {
            breaking_changes_risk: 'high',
          },
        });
      }
    }
    return libraries;
  }

  private extractContracts(content: string, filePath: string, imported: Set<ValidationLibrary>): ValidationContract[] {
    const contracts: ValidationContract[] = [];
    if (imported.has('zod')) contracts.push(...this.extractObjectCallSchemas(content, filePath, 'zod', /\bz\.object\s*\(\s*\{/g));
    if (imported.has('yup')) contracts.push(...this.extractObjectCallSchemas(content, filePath, 'yup', /\byup\.object(?:\s*\(\s*\))?\s*(?:\.shape)?\s*\(\s*\{/g));
    if (imported.has('joi')) {
      contracts.push(...this.extractObjectCallSchemas(content, filePath, 'joi', /\bJoi\.object\s*\(\s*\{/g));
      contracts.push(...this.extractJoiBuilderSchemas(content, filePath));
    }
    if (imported.has('ajv')) contracts.push(...this.extractJsonSchemas(content, filePath));
    if (imported.has('class-validator')) contracts.push(...this.extractClassValidatorDtos(content, filePath));
    if (imported.has('marshmallow')) contracts.push(...this.extractMarshmallowSchemas(content, filePath));
    if (imported.has('cerberus')) contracts.push(...this.extractCerberusSchemas(content, filePath));
    return contracts;
  }

  private extractObjectCallSchemas(content: string, filePath: string, library: Extract<ValidationLibrary, 'zod' | 'yup' | 'joi'>, callPattern: RegExp): ValidationContract[] {
    const contracts: ValidationContract[] = [];
    let match: RegExpExecArray | null;
    callPattern.lastIndex = 0;
    while ((match = callPattern.exec(content)) !== null) {
      const assignment = this.findAssignmentName(content, match.index);
      if (!assignment) continue;
      const bodyStart = content.indexOf('{', match.index);
      const bodyEnd = this.findMatching(content, bodyStart, '{', '}');
      if (bodyStart === -1 || bodyEnd === -1) continue;
      const body = content.slice(bodyStart + 1, bodyEnd);
      const line = this.lineForIndex(content, assignment.index);
      contracts.push({
        id: this.contractId(library, filePath, assignment.name),
        name: assignment.name,
        variableName: assignment.name,
        library,
        kind: `${library}-object-schema`,
        fields: this.parseJsSchemaFields(body, library),
        filePath,
        line,
        endLine: this.lineForIndex(content, bodyEnd),
        evidence: content.slice(assignment.index, Math.min(bodyEnd + 1, assignment.index + 220)).replace(/\s+/g, ' ').trim(),
      });
    }
    return contracts;
  }










  private extractJoiBuilderSchemas(content: string, filePath: string): ValidationContract[] {
    const contracts: ValidationContract[] = [];
    const builders = ['string', 'number', 'boolean', 'date', 'array', 'binary', 'alternatives', 'any', 'symbol', 'link'];
    const seen = new Set<string>();

    const pushScalar = (name: string, index: number, expression: string) => {
      if (seen.has(name)) return;
      seen.add(name);
      const line = this.lineForIndex(content, index);
      contracts.push({
        id: this.contractId('joi', filePath, name),
        name,
        variableName: name,
        library: 'joi',
        kind: 'joi-builder-schema',
        fields: [],
        filePath,
        line,
        endLine: line,
        evidence: expression.replace(/\s+/g, ' ').trim().slice(0, 220),
      });
    };


    const defaultChain = new RegExp(
      `(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(Joi\\.(?:${builders.join('|')})\\s*\\([^)]*\\)(?:\\s*\\.[A-Za-z_$][\\w$]*\\s*\\([^)]*\\))*)`,
      'g'
    );
    let match: RegExpExecArray | null;
    while ((match = defaultChain.exec(content)) !== null) {
      pushScalar(match[1], match.index, match[2]);
    }


    const namedImport = /import\s*\{([^}]+)\}\s*from\s*['"](?:joi|@hapi\/joi)['"]/.exec(content);
    if (!namedImport) return contracts;
    const locals = new Map<string, string>();
    for (const piece of namedImport[1].split(',')) {
      const renamed = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(piece);
      if (renamed) locals.set(renamed[2] || renamed[1], renamed[1]);
    }

    for (const [local, original] of locals) {
      if (original === 'object') {
        contracts.push(...this.extractObjectCallSchemas(content, filePath, 'joi', new RegExp(`(?<![.\\w])${this.escapeRegExp(local)}\\s*\\(\\s*\\{`, 'g')));
      } else if (builders.includes(original)) {
        const namedChain = new RegExp(
          `(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(${this.escapeRegExp(local)}\\s*\\([^)]*\\)(?:\\s*\\.[A-Za-z_$][\\w$]*\\s*\\([^)]*\\))*)`,
          'g'
        );
        while ((match = namedChain.exec(content)) !== null) {
          pushScalar(match[1], match.index, match[2]);
        }
      }
    }

    return contracts;
  }

  private extractJsonSchemas(content: string, filePath: string): ValidationContract[] {
    const contracts: ValidationContract[] = [];
    const schemaRegex = /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = schemaRegex.exec(content)) !== null) {
      const start = content.indexOf('{', match.index);
      const end = this.findMatching(content, start, '{', '}');
      if (start === -1 || end === -1) continue;
      const body = content.slice(start + 1, end);
      if (!/\btype\s*:\s*['"]object['"]/.test(body) || !/\bproperties\s*:/.test(body)) continue;
      const line = this.lineForIndex(content, match.index);
      contracts.push({
        id: this.contractId('ajv', filePath, match[1]),
        name: match[1],
        variableName: match[1],
        library: 'ajv',
        kind: 'json-schema',
        fields: this.parseJsonSchemaFields(body),
        filePath,
        line,
        endLine: this.lineForIndex(content, end),
        evidence: content.slice(match.index, Math.min(end + 1, match.index + 220)).replace(/\s+/g, ' ').trim(),
      });
    }
    return contracts;
  }

  private extractClassValidatorDtos(content: string, filePath: string): ValidationContract[] {
    const contracts: ValidationContract[] = [];
    const classRegex = /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\s*(?:\{|\s+[^{]*\{)/g;
    let match: RegExpExecArray | null;
    while ((match = classRegex.exec(content)) !== null) {
      const bodyStart = content.indexOf('{', match.index);
      const bodyEnd = this.findMatching(content, bodyStart, '{', '}');
      if (bodyStart === -1 || bodyEnd === -1) continue;
      const body = content.slice(bodyStart + 1, bodyEnd);
      if (!/@Is[A-Za-z]+\s*\(/.test(body)) continue;
      const line = this.lineForIndex(content, match.index);
      contracts.push({
        id: this.contractId('class-validator', filePath, match[1]),
        name: match[1],
        variableName: match[1],
        library: 'class-validator',
        kind: 'decorated-dto',
        fields: this.parseClassValidatorFields(body),
        filePath,
        line,
        endLine: this.lineForIndex(content, bodyEnd),
        evidence: content.slice(match.index, Math.min(bodyEnd + 1, match.index + 220)).replace(/\s+/g, ' ').trim(),
      });
    }
    return contracts;
  }

  private extractMarshmallowSchemas(content: string, filePath: string): ValidationContract[] {
    const contracts: ValidationContract[] = [];
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^class\s+([A-Za-z_][\w]*)\s*\([^)]*\bSchema\b[^)]*\)\s*:/);
      if (!match) continue;
      const bodyLines = this.collectPythonBlock(lines, i);
      const fields = this.parsePythonFieldAssignments(bodyLines.join('\n'), /fields\.([A-Za-z_][\w]*)\s*\(([^)]*)\)/g);
      if (fields.length === 0) continue;
      contracts.push({
        id: this.contractId('marshmallow', filePath, match[1]),
        name: match[1],
        variableName: match[1],
        library: 'marshmallow',
        kind: 'marshmallow-schema',
        fields,
        filePath,
        line: i + 1,
        endLine: i + bodyLines.length,
        evidence: lines[i].trim(),
      });
    }
    return contracts;
  }

  private extractCerberusSchemas(content: string, filePath: string): ValidationContract[] {
    const contracts: ValidationContract[] = [];
    const schemaRegex = /([A-Za-z_][\w]*)\s*=\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = schemaRegex.exec(content)) !== null) {
      const start = content.indexOf('{', match.index);
      const end = this.findMatching(content, start, '{', '}');
      if (start === -1 || end === -1) continue;
      const body = content.slice(start + 1, end);
      if (!/['"]type['"]\s*:/.test(body)) continue;
      const fields = this.parseCerberusFields(body);
      if (fields.length === 0) continue;
      contracts.push({
        id: this.contractId('cerberus', filePath, match[1]),
        name: match[1],
        variableName: match[1],
        library: 'cerberus',
        kind: 'cerberus-schema',
        fields,
        filePath,
        line: this.lineForIndex(content, match.index),
        endLine: this.lineForIndex(content, end),
        evidence: content.slice(match.index, Math.min(end + 1, match.index + 220)).replace(/\s+/g, ' ').trim(),
      });
    }
    return contracts;
  }

  private parseJsSchemaFields(body: string, library: 'zod' | 'yup' | 'joi'): ValidationField[] {
    const fields: ValidationField[] = [];
    const fieldRegex = /(?:^|,|\n)\s*['"]?([A-Za-z_$][\w$-]*)['"]?\s*:\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)(?:\s*\(([^)]*)\))?((?:\.[A-Za-z_$][\w$]*\s*\([^)]*\))*)/g;
    let match: RegExpExecArray | null;
    while ((match = fieldRegex.exec(body)) !== null) {
      const expression = `${match[2]}(${match[3] || ''})${match[4] || ''}`;
      fields.push({
        name: match[1],
        type: this.inferJsFieldType(expression),
        required: library === 'joi' ? !/\.optional\s*\(/.test(expression) : !/\.optional\s*\(|\.nullable\s*\(/.test(expression),
        validators: this.extractValidatorCalls(expression),
      });
    }
    return fields;
  }

  private parseJsonSchemaFields(body: string): ValidationField[] {
    const required = new Set<string>();
    const requiredMatch = body.match(/\brequired\s*:\s*\[([^\]]*)\]/);
    if (requiredMatch) {
      for (const item of requiredMatch[1].match(/['"]([^'"]+)['"]/g) || []) {
        required.add(item.slice(1, -1));
      }
    }

    const propsMatch = body.match(/\bproperties\s*:\s*\{([\s\S]*)\}\s*,?\s*(?:required|additionalProperties|$)/);
    const propsBody = propsMatch?.[1] || body;
    const fields: ValidationField[] = [];
    const fieldRegex = /['"]?([A-Za-z_$][\w$-]*)['"]?\s*:\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = fieldRegex.exec(propsBody)) !== null) {
      const typeMatch = match[2].match(/\btype\s*:\s*['"]([^'"]+)['"]/);
      if (!typeMatch) continue;
      fields.push({
        name: match[1],
        type: typeMatch[1],
        required: required.has(match[1]),
        validators: this.extractJsonSchemaValidators(match[2]),
      });
    }
    return fields;
  }

  private parseClassValidatorFields(body: string): ValidationField[] {
    const fields: ValidationField[] = [];
    const lines = body.split(/\r?\n/);
    let decorators: string[] = [];
    let decoratorArgs: Record<string, string> = {};
    for (const line of lines) {
      const trimmed = line.trim();





      const decorator = trimmed.match(/^@([A-Za-z_$][\w$]*)\s*\(/);
      if (decorator) {
        const openParen = line.indexOf('(', line.indexOf('@'));
        const close = this.findMatching(line, openParen, '(', ')');
        const args = close > openParen ? line.slice(openParen + 1, close).trim() : '';
        decorators.push(decorator[1]);
        if (args) decoratorArgs[decorator[1]] = args;
        continue;
      }
      const field = trimmed.match(/^(?:readonly\s+)?([A-Za-z_$][\w$]*)[!?]?\s*:\s*([^;=]+)/);
      if (field && decorators.length > 0) {
        fields.push({
          name: field[1],
          type: field[2].trim(),
          required: !decorators.includes('IsOptional'),
          validators: [...decorators],
          decoratorArgs: Object.keys(decoratorArgs).length ? { ...decoratorArgs } : undefined,
        });
        decorators = [];
        decoratorArgs = {};
      } else if (trimmed && !trimmed.startsWith('@')) {
        decorators = [];
        decoratorArgs = {};
      }
    }
    return fields;
  }

  private parsePythonFieldAssignments(body: string, valuePattern: RegExp): ValidationField[] {
    const fields: ValidationField[] = [];
    const fieldRegex = /^(\s*)([A-Za-z_][\w]*)\s*=\s*/gm;
    let fieldMatch: RegExpExecArray | null;
    while ((fieldMatch = fieldRegex.exec(body)) !== null) {
      valuePattern.lastIndex = fieldMatch.index;
      const valueMatch = valuePattern.exec(body);
      if (!valueMatch || valueMatch.index > fieldMatch.index + 160) continue;
      const args = valueMatch[2] || '';
      fields.push({
        name: fieldMatch[2],
        type: this.normalizePythonFieldType(valueMatch[1]),
        required: /required\s*=\s*True/.test(args),
        validators: this.extractPythonValidators(args),
      });
    }
    return fields;
  }

  private parseCerberusFields(body: string): ValidationField[] {
    const fields: ValidationField[] = [];
    const fieldRegex = /['"]([A-Za-z_][\w-]*)['"]\s*:\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = fieldRegex.exec(body)) !== null) {
      const typeMatch = match[2].match(/['"]type['"]\s*:\s*['"]([^'"]+)['"]/);
      if (!typeMatch) continue;
      fields.push({
        name: match[1],
        type: typeMatch[1],
        required: /['"]required['"]\s*:\s*True/.test(match[2]),
        validators: this.extractCerberusValidators(match[2]),
      });
    }
    return fields;
  }

  private extractHandlerUsages(content: string, filePath: string, contracts: ValidationContract[]): HandlerUsage[] {
    const usages: HandlerUsage[] = [];
    const lines = content.split(/\r?\n/);
    for (const contract of contracts) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!this.lineUsesContract(line, contract)) continue;
        const handler = this.findEnclosingRouteHandler(lines, i);
        if (!handler) continue;
        usages.push({
          id: `validation_handler_${this.sanitizeId(filePath)}_${handler.line}_${this.sanitizeId(handler.name)}`,
          name: handler.name,
          filePath,
          line: handler.line,
          contractId: contract.id,
          contractName: contract.name,
          evidence: line.trim().slice(0, 180),
        });
      }
    }
    return usages;
  }

  private lineUsesContract(line: string, contract: ValidationContract): boolean {
    const escapedVar = this.escapeRegExp(contract.variableName);
    const escapedName = this.escapeRegExp(contract.name);
    return new RegExp(`\\b${escapedVar}\\s*\\.(parse|safeParse|validate|validateAsync|load)\\s*\\(`).test(line) ||
      new RegExp(`\\b${escapedName}\\s*\\(\\s*\\)\\s*\\.load\\s*\\(`).test(line) ||
      new RegExp(`\\bnew\\s+Validator\\s*\\([^)]*\\)\\.validate\\s*\\([^,]+,\\s*${escapedVar}\\b`).test(line) ||
      new RegExp(`:\\s*${escapedName}\\b`).test(line);
  }

  private findEnclosingRouteHandler(lines: string[], usageIndex: number): { name: string; line: number } | undefined {
    for (let i = usageIndex; i >= Math.max(0, usageIndex - 35); i--) {
      const line = lines[i];
      const functionMatch = line.match(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/) ||
        line.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/) ||
        line.match(/^\s*(?:(?:public|private|protected|readonly)\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/);
      if (!functionMatch || this.isControlFlowKeyword(functionMatch[1])) continue;
      if (this.hasRouteEvidence(lines, i)) return { name: functionMatch[1], line: i + 1 };
    }
    return undefined;
  }

  private isControlFlowKeyword(value: string): boolean {
    return ['if', 'for', 'while', 'switch', 'catch', 'with'].includes(value);
  }

  private hasRouteEvidence(lines: string[], handlerIndex: number): boolean {
    const nearby = lines.slice(Math.max(0, handlerIndex - 6), Math.min(lines.length, handlerIndex + 3)).join('\n');
    return /@[A-Za-z0-9_]*(Get|Post|Put|Patch|Delete)\b/i.test(nearby) ||
      /\b(router|app)\.(get|post|put|patch|delete)\s*\(/i.test(nearby) ||
      /@(app|router)\.(get|post|put|patch|delete)\s*\(/i.test(nearby);
  }

  private importedLibraries(content: string): Set<ValidationLibrary> {
    const imports = this.extractImports(content);
    const libraries = new Set<ValidationLibrary>();
    for (const [library, packages] of Object.entries(LIBRARY_PACKAGES) as Array<[ValidationLibrary, string[]]>) {
      if (imports.some(source => packages.some(pkg => source === pkg || source.startsWith(`${pkg}/`)))) {
        libraries.add(library);
      }
    }
    return libraries;
  }

  private extractImports(content: string): string[] {
    const corpusImports = this.sourceImports(content);
    if (corpusImports) return [...corpusImports];
    const imports = new Set<string>();
    for (const line of content.split(/\r?\n/)) {
      const importMatch = line.match(/^\s*import\s+(?:.+?\s+from\s+)?['"]([^'"]+)['"]/);
      const requireMatch = line.match(/\brequire\(['"]([^'"]+)['"]\)/);


      const fromMatch = line.match(/^\s*\}?\s*from\s+['"]([^'"]+)['"]/);
      const pythonMatch = line.match(/^\s*(?:from\s+([a-zA-Z0-9_.-]+)\s+import|import\s+([a-zA-Z0-9_.-]+))/);
      const value = importMatch?.[1] || requireMatch?.[1] || fromMatch?.[1] || pythonMatch?.[1] || pythonMatch?.[2];
      if (value) imports.add(value);
    }
    return [...imports];
  }

  private fileMayContainValidation(content: string): boolean {




    return /(z\.object|yup\.object|Joi\.[a-z]+\s*\(|new\s+Ajv|@Is[A-Za-z]+|fields\.[A-Za-z]+|Validator\s*\(|Schema\b|(?:from\s*|require\s*\(\s*)['"](?:joi|@hapi\/joi)['"])/.test(content);
  }

  private async sourceFiles(contextOrPath: AnalysisContext | string): Promise<string[]> {
    const context = typeof contextOrPath === 'string' ? { projectPath: contextOrPath } : contextOrPath;
    const groundedFiles = this.filesFromExistingAnalysis(
      context,
      source => ALL_PACKAGES.some(packageName => source === packageName || source.startsWith(`${packageName}/`)),
      true
    );
    const conventionFiles = await glob([
      '**/*{dto,schema,validator,validation,contract}*.{ts,tsx,js,jsx,py}',
    ], {
      cwd: context.projectPath,
      ignore: [...this.getIgnorePatterns(context), '**/*.test.*', '**/*.spec.*'],
      nodir: true,
      absolute: false,
    });
    const evidenceFiles = [...new Set([...groundedFiles, ...conventionFiles])].sort();
    if ((context.existingAnalysis?.length || 0) > 0 && evidenceFiles.length > 0) {
      return this.capAndPrioritizeSourceFiles(evidenceFiles, 'validation schema candidate files');
    }

    return this.capAndPrioritizeSourceFiles(await glob('**/*.{ts,tsx,js,jsx,py}', {
      cwd: context.projectPath,
      ignore: [...this.getIgnorePatterns(context), '**/*.test.*', '**/*.spec.*'],
      nodir: true,
      absolute: false,
    }), 'validation schema candidate files');
  }

  private async readDependencies(projectPath: string): Promise<DependencyHit[]> {
    return [
      ...await this.readPackageJsonDependencies(projectPath),
      ...await this.readPythonDependencies(projectPath),
    ];
  }

  private async readPackageJsonDependencies(projectPath: string): Promise<DependencyHit[]> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (!await fs.pathExists(packageJsonPath)) return [];
    const pkg = await fs.readJson(packageJsonPath);
    const hits: DependencyHit[] = [];
    const add = (deps: Record<string, string> | undefined, type: CASLibrary['type']) => {
      for (const [name, version] of Object.entries(deps || {})) {
        hits.push({ name, version: String(version).replace(/^[\^~>=<]/, ''), type, packageManager: 'npm' });
      }
    };
    add(pkg.dependencies, 'production');
    add(pkg.devDependencies, 'development');
    add(pkg.peerDependencies, 'peer');
    add(pkg.optionalDependencies, 'optional');
    return hits;
  }

  private async readPythonDependencies(projectPath: string): Promise<DependencyHit[]> {
    const hits: DependencyHit[] = [];
    for (const file of ['requirements.txt', 'requirements/base.txt', 'requirements/production.txt', 'pyproject.toml']) {
      const reqPath = path.join(projectPath, file);
      if (!await fs.pathExists(reqPath)) continue;
      const content = await fs.readFile(reqPath, 'utf8');
      for (const pkg of ['marshmallow', 'cerberus']) {
        const match = new RegExp(`\\b${pkg}\\b\\s*(?:[><=!~]+\\s*([^,;\\s]+))?`, 'i').exec(content);
        if (match) hits.push({ name: pkg, version: match[1], type: 'production', packageManager: 'pip' });
      }
    }
    return hits;
  }

  private findAssignmentName(content: string, index: number): { name: string; index: number } | undefined {
    const prefix = content.slice(Math.max(0, index - 220), index);
    const match = /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(prefix);
    if (!match) return undefined;
    return { name: match[1], index: index - match[0].length };
  }

  private findMatching(content: string, start: number, open: string, close: string): number {
    if (start < 0 || content[start] !== open) return -1;
    let depth = 0;
    let quote: string | undefined;
    for (let i = start; i < content.length; i++) {
      const char = content[i];
      const prev = content[i - 1];
      if (quote) {
        if (char === quote && prev !== '\\') quote = undefined;
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        quote = char;
        continue;
      }
      if (char === open) depth += 1;
      if (char === close) depth -= 1;
      if (depth === 0) return i;
    }
    return -1;
  }

  private collectPythonBlock(lines: string[], classLine: number): string[] {
    const body: string[] = [];
    for (let i = classLine + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() && !/^\s/.test(line)) break;
      body.push(line);
    }
    return body;
  }

  private inferJsFieldType(expression: string): string {
    const normalized = expression.toLowerCase();
    if (/\b(string|str)\b/.test(normalized)) return 'string';
    if (/\b(number|integer|int)\b/.test(normalized)) return 'number';
    if (/\b(boolean|bool)\b/.test(normalized)) return 'boolean';
    if (/\b(array)\b/.test(normalized)) return 'array';
    if (/\bdate\b/.test(normalized)) return 'date';
    if (/\bobject\b/.test(normalized)) return 'object';
    return 'unknown';
  }

  private extractValidatorCalls(expression: string): string[] {
    return [...expression.matchAll(/\.([A-Za-z_$][\w$]*)\s*\(/g)].map(match => match[1]);
  }

  private extractJsonSchemaValidators(body: string): string[] {
    const validators: string[] = [];
    for (const key of ['format', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'enum']) {
      if (new RegExp(`\\b${key}\\s*:`).test(body)) validators.push(key);
    }
    return validators;
  }

  private extractPythonValidators(args: string): string[] {
    const validators: string[] = [];
    for (const key of ['validate', 'missing', 'allow_none', 'load_only', 'dump_only']) {
      if (new RegExp(`\\b${key}\\s*=`).test(args)) validators.push(key);
    }
    return validators;
  }

  private extractCerberusValidators(body: string): string[] {
    const validators: string[] = [];
    for (const key of ['min', 'max', 'minlength', 'maxlength', 'regex', 'allowed', 'schema']) {
      if (new RegExp(`['"]${key}['"]\\s*:`).test(body)) validators.push(key);
    }
    return validators;
  }

  private normalizePythonFieldType(value: string): string {
    const lower = value.toLowerCase();
    if (['str', 'string', 'email', 'url'].includes(lower)) return 'string';
    if (['int', 'integer', 'float', 'decimal', 'number'].includes(lower)) return 'number';
    if (['bool', 'boolean'].includes(lower)) return 'boolean';
    if (['list', 'nested'].includes(lower)) return 'array';
    return lower;
  }

  private contractId(library: ValidationLibrary, filePath: string, name: string): string {
    return `validation_contract_${this.sanitizeId(library)}_${this.sanitizeId(filePath)}_${this.sanitizeId(name)}`;
  }

  private lineForIndex(content: string, index: number): number {
    return this.sourceLineForIndex(content, index);
  }

  private packageMatches(name: string, expected: string): boolean {
    const normalized = name.toLowerCase();
    const target = expected.toLowerCase();
    return normalized === target || normalized.startsWith(`${target}/`);
  }

  private async safeRead(filePath: string): Promise<string | undefined> {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch {
      return undefined;
    }
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

}




export interface ValidationContractField {
  name: string;
  type?: string;
  required?: boolean;
  validators?: string[];
  decoratorArgs?: Record<string, string>;
}












export function describeValidationRules(fields: ValidationContractField[]): string[] {
  const rules: string[] = [];
  for (const field of fields) {
    const rule = describeFieldRule(field);
    if (rule) rules.push(rule);
  }
  return rules;
}

const TYPE_PHRASE: Record<string, string> = {
  IsString: 'a string',
  IsNumberString: 'a numeric string',
  IsNumber: 'a number',
  IsInt: 'an integer',
  IsBoolean: 'a boolean',
  IsArray: 'an array',
  IsObject: 'an object',
  IsDate: 'a date',
  IsDateString: 'a date string',
  IsUUID: 'a UUID',
  IsEmail: 'a valid email',
  IsUrl: 'a valid URL',
  IsIP: 'an IP address',
  IsPhoneNumber: 'a phone number',
};









function isNonConstraintDecorator(name: string): boolean {
  if (name === 'IsOptional' || name === 'IsDefined') return true;
  if (name === 'Type' || name === 'Expose' || name === 'Transform') return true;
  if (name === 'ApiProperty' || name === 'ApiPropertyOptional') return true;
  if (/Property$/.test(name)) return true;
  return false;
}

function describeFieldRule(field: ValidationContractField): string | null {
  const validators = field.validators || [];
  if (validators.length === 0) return null;
  const args = field.decoratorArgs || {};
  const optional = validators.includes('IsOptional');



  const clauses: string[] = [];


  const typeDec = validators.find(v => v in TYPE_PHRASE);
  let base = typeDec ? TYPE_PHRASE[typeDec] : undefined;
  if (validators.includes('IsNotEmpty')) {
    base = base ? `a non-empty ${base.replace(/^an? /, '')}` : 'non-empty';
  }
  if (base) clauses.push(base);


  if (validators.includes('IsEnum') && args.IsEnum) {
    clauses.push(`one of the ${args.IsEnum.split(/[,)]/)[0].trim()} values`);
  } else if (validators.includes('IsIn') && args.IsIn) {
    clauses.push(`one of ${collapse(args.IsIn)}`);
  }


  if (validators.includes('Min') && args.Min !== undefined) clauses.push(`>= ${firstArg(args.Min)}`);
  if (validators.includes('Max') && args.Max !== undefined) clauses.push(`<= ${firstArg(args.Max)}`);


  if (validators.includes('Length') && args.Length !== undefined) {
    const parts = args.Length.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) clauses.push(`length ${parts[0]}-${parts[1]}`);
    else if (parts.length === 1) clauses.push(`min length ${parts[0]}`);
  }
  if (validators.includes('MinLength') && args.MinLength !== undefined) clauses.push(`min length ${firstArg(args.MinLength)}`);
  if (validators.includes('MaxLength') && args.MaxLength !== undefined) clauses.push(`max length ${firstArg(args.MaxLength)}`);
  if (validators.includes('ArrayMinSize') && args.ArrayMinSize !== undefined) clauses.push(`>= ${firstArg(args.ArrayMinSize)} items`);
  if (validators.includes('ArrayMaxSize') && args.ArrayMaxSize !== undefined) clauses.push(`<= ${firstArg(args.ArrayMaxSize)} items`);
  if (validators.includes('ArrayUnique')) clauses.push('unique items');


  if (validators.includes('Matches')) clauses.push('matching the required pattern');
  if (validators.includes('ValidateNested')) clauses.push('a validated nested object');



  if (clauses.length === 0) {
    const custom = validators.filter(v => !isNonConstraintDecorator(v));
    if (custom.length === 0) return null;
    return `${field.name} constrained by ${custom.join(', ')}${optional ? ' (optional)' : ''}`;
  }

  const body = clauses.join(', ');
  return `${field.name} must be ${body}${optional ? ' (optional)' : ''}`;
}

function firstArg(raw: string): string {
  return raw.split(',')[0].trim();
}

function collapse(raw: string): string {


  const inner = raw.replace(/^\[|\]$/g, '');
  const items = inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  if (items.length === 0) return raw.trim();
  const shown = items.slice(0, 6).join(', ');
  return items.length > 6 ? `${shown}, ...` : shown;
}
