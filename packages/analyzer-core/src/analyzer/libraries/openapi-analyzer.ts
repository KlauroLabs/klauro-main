import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, FileAnalysisResult
} from '../../types/cas.types';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';
import * as path from 'path';

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace'];
const SPEC_GLOBS = ['**/*.yaml', '**/*.yml', '**/*.json'];

const SPEC_SIGNAL = /("?openapi"?\s*:\s*["']?3|"?swagger"?\s*:\s*["']?2)/i;
const SPEC_FILENAMES = new Set(['openapi.json', 'openapi.yaml', 'openapi.yml', 'swagger.json', 'swagger.yaml', 'swagger.yml']);

interface OpenApiOperation {
  method: string;
  apiPath: string;
  operationId?: string;
  summary?: string;
  tags: string[];
  refs: string[];
}

interface OpenApiProperty {
  name: string;
  type: string;
  required: boolean;
  ref?: string;
}

interface OpenApiSchema {
  name: string;
  properties: OpenApiProperty[];
  refs: string[];
}

interface OpenApiSpec {
  relativePath: string;
  title?: string;
  version?: string;
  operations: OpenApiOperation[];
  schemas: OpenApiSchema[];
}

export class OpenAPIAnalyzer extends BaseAnalyzer {
  constructor() {
    super('openapi', 'OpenAPI/Swagger Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const files = await this.findSpecFiles(projectPath, { projectPath }, true);
      return files.length > 0;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await this.findSpecFiles(projectPath, { projectPath }, false);
    return files.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);
    const spec = this.parseSpec(context.relativePath, content);

    if (spec) {
      this.emitSpec(spec, nodes, edges, entryPoints);
    }

    const exports = spec ? spec.schemas.map(s => s.name) : [];

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
      exports
    );
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    this.resetAnalysisWarnings();
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    let specFiles = await this.findSpecFiles(context.projectPath, context, false);
    specFiles.sort();
    specFiles = this.capAndPrioritizeSourceFiles(specFiles, 'OpenAPI specs');

    let specsParsed = 0;
    for (const relativePath of specFiles) {
      const fullPath = path.join(context.projectPath, relativePath);
      let content = '';
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }
      const spec = this.parseSpec(relativePath, content);
      if (!spec) continue;
      specsParsed += 1;
      this.emitSpec(spec, nodes, edges, entryPoints);
    }

    const warnings = this.collectAnalysisWarnings();
    const operationCount = nodes.filter(n => n.type === 'api-operation').length;
    const schemaCount = nodes.filter(n => n.type === 'entity').length;
    return this.createContribution(nodes, edges, entryPoints, exitPoints, {
      ...(warnings.length > 0 ? { warnings } : {}),
      framework_specific: {
        specType: 'openapi',
        specsAnalyzed: specsParsed,
        operationsFound: operationCount,
        schemasFound: schemaCount,
      }
    });
  }



  private emitSpec(
    spec: OpenApiSpec,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const schemaNodeId = (name: string) => `openapi_schema_${this.sanitizeId(name)}`;
    const knownSchemas = new Set(spec.schemas.map(s => s.name));


    for (const schema of spec.schemas) {
      const nodeId = schemaNodeId(schema.name);
      const fields = schema.properties.map(p => ({
        name: p.name,
        type: p.ref ? p.ref : p.type,
        required: p.required,
        relation: !!p.ref,
      }));
      nodes.push(this.createNode(
        nodeId,
        schema.name,
        'entity',
        3,
        spec.relativePath,
        undefined,
        undefined,
        {
          source: 'openapi_schema',
          contract: 'data',
          specTitle: spec.title,
          fields,
          annotations: ['OpenAPISchema'],
          subcategories: ['entity', 'openapi', 'contract'],
        }
      ));


      for (const ref of schema.refs) {
        if (knownSchemas.has(ref) && ref !== schema.name) {
          edges.push(this.createEdge(
            `openapi_ref_${this.sanitizeId(schema.name)}_${this.sanitizeId(ref)}`,
            nodeId,
            schemaNodeId(ref),
            'references',
            'contract',
            { attributes: { kind: 'schema-ref', target: ref } }
          ));
        }
      }
    }


    for (const op of spec.operations) {
      const opKey = op.operationId || `${op.method}_${op.apiPath}`;
      const nodeId = `openapi_op_${this.sanitizeId(opKey)}`;
      const displayName = op.operationId || `${op.method.toUpperCase()} ${op.apiPath}`;

      nodes.push(this.createNode(
        nodeId,
        displayName,
        'api-operation',
        3,
        spec.relativePath,
        undefined,
        undefined,
        {
          source: 'openapi_operation',
          httpMethod: op.method.toUpperCase(),
          httpPath: op.apiPath,
          operationId: op.operationId,
          summary: op.summary,
          tags: op.tags,
          contractRefs: op.refs,
          subcategories: ['operation', 'openapi', 'api'],
        }
      ));

      entryPoints.push(this.createEntryPoint(
        `openapi_entry_${this.sanitizeId(opKey)}`,
        nodeId,
        'http',
        displayName,
        op.summary,
        { method: op.method.toUpperCase(), path: op.apiPath }
      ));


      for (const ref of op.refs) {
        if (knownSchemas.has(ref)) {
          edges.push(this.createEdge(
            `openapi_contract_${this.sanitizeId(opKey)}_${this.sanitizeId(ref)}`,
            nodeId,
            schemaNodeId(ref),
            'references',
            'contract',
            { attributes: { kind: 'operation-contract', target: ref } }
          ));
        }
      }
    }
  }



  private async findSpecFiles(
    projectPath: string,
    context: AnalysisContext,
    stopEarly: boolean
  ): Promise<string[]> {
    const ignore = this.getIgnorePatterns(context);
    const candidates = await glob(SPEC_GLOBS, {
      cwd: projectPath,
      ignore,
      nodir: true,
    });

    const matched: string[] = [];
    for (const rel of candidates) {
      const base = path.basename(rel).toLowerCase();
      const fullPath = path.join(projectPath, rel);
      let head = '';
      try {
        head = await this.readHead(fullPath, 4096);
      } catch {
        continue;
      }
      if (SPEC_FILENAMES.has(base) ? SPEC_SIGNAL.test(head) || /openapi|swagger/i.test(head) : SPEC_SIGNAL.test(head)) {
        matched.push(rel);
        if (stopEarly) return matched;
      }
    }
    return matched;
  }

  private async readHead(fullPath: string, bytes: number): Promise<string> {
    const fd = await fs.open(fullPath, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await fs.read(fd, buf, 0, bytes, 0);
      return buf.toString('utf-8', 0, bytesRead);
    } finally {
      await fs.close(fd);
    }
  }



  private parseSpec(relativePath: string, content: string): OpenApiSpec | null {
    const trimmed = content.trimStart();
    if (trimmed.startsWith('{')) {
      return this.parseJsonSpec(relativePath, content);
    }
    return this.parseYamlSpec(relativePath, content);
  }

  private refName(ref: string): string | undefined {

    const m = ref.match(/#\/(?:components\/schemas|definitions)\/([A-Za-z0-9_.-]+)/);
    return m ? m[1] : undefined;
  }

  private collectRefs(value: any, acc: Set<string>): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) this.collectRefs(item, acc);
      return;
    }
    for (const [key, val] of Object.entries(value)) {
      if (key === '$ref' && typeof val === 'string') {
        const name = this.refName(val);
        if (name) acc.add(name);
      } else {
        this.collectRefs(val, acc);
      }
    }
  }

  private parseJsonSpec(relativePath: string, content: string): OpenApiSpec | null {
    let doc: any;
    try {
      doc = JSON.parse(content);
    } catch {
      return null;
    }
    if (!doc || (typeof doc.openapi !== 'string' && typeof doc.swagger !== 'string')) {
      return null;
    }

    const operations: OpenApiOperation[] = [];
    const paths = doc.paths || {};
    for (const [apiPath, pathItem] of Object.entries<any>(paths)) {
      if (!pathItem || typeof pathItem !== 'object') continue;
      for (const method of HTTP_METHODS) {
        const opObj = pathItem[method];
        if (!opObj || typeof opObj !== 'object') continue;
        const refs = new Set<string>();
        this.collectRefs(opObj.requestBody, refs);
        this.collectRefs(opObj.parameters, refs);
        this.collectRefs(opObj.responses, refs);
        operations.push({
          method,
          apiPath,
          operationId: typeof opObj.operationId === 'string' ? opObj.operationId : undefined,
          summary: typeof opObj.summary === 'string' ? opObj.summary : undefined,
          tags: Array.isArray(opObj.tags) ? opObj.tags.filter((t: any) => typeof t === 'string') : [],
          refs: [...refs],
        });
      }
    }

    const schemaContainer = doc.components?.schemas || doc.definitions || {};
    const schemas: OpenApiSchema[] = [];
    for (const [name, schemaObj] of Object.entries<any>(schemaContainer)) {
      if (!schemaObj || typeof schemaObj !== 'object') continue;
      const requiredList: string[] = Array.isArray(schemaObj.required) ? schemaObj.required : [];
      const properties: OpenApiProperty[] = [];
      const props = schemaObj.properties || {};
      for (const [propName, propObj] of Object.entries<any>(props)) {
        const ref = propObj?.$ref ? this.refName(propObj.$ref)
          : propObj?.items?.$ref ? this.refName(propObj.items.$ref)
          : undefined;
        const type = propObj?.type
          ? (propObj.type === 'array' && propObj.items?.type ? `${propObj.items.type}[]` : propObj.type)
          : (ref ? ref : 'object');
        properties.push({
          name: propName,
          type,
          required: requiredList.includes(propName),
          ref,
        });
      }
      const refs = new Set<string>();
      this.collectRefs(schemaObj, refs);
      refs.delete(name);
      schemas.push({ name, properties, refs: [...refs] });
    }

    return {
      relativePath,
      title: doc.info?.title,
      version: doc.openapi || doc.swagger,
      operations,
      schemas,
    };
  }


  private parseYamlSpec(relativePath: string, content: string): OpenApiSpec | null {
    const lines = content.split(/\r?\n/);
    let title: string | undefined;
    let version: string | undefined;


    if (!lines.some(l => /^\s{0,2}(openapi|swagger)\s*:/.test(l))) {
      return null;
    }

    const indentOf = (line: string) => line.match(/^(\s*)/)![1].length;


    const sectionRange = (key: string): [number, number] | null => {
      const re = new RegExp(`^${key}\\s*:`);
      let start = -1;
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) { start = i; break; }
      }
      if (start === -1) return null;
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i++) {
        const l = lines[i];
        if (l.trim() === '' || l.trim().startsWith('#')) continue;
        if (indentOf(l) === 0) { end = i; break; }
      }
      return [start, end];
    };


    const infoRange = sectionRange('info');
    if (infoRange) {
      for (let i = infoRange[0] + 1; i < infoRange[1]; i++) {
        const tm = lines[i].match(/^\s+title\s*:\s*["']?(.+?)["']?\s*$/);
        if (tm) { title = tm[1]; break; }
      }
    }
    const versionLine = lines.find(l => /^\s{0,2}(openapi|swagger)\s*:/.test(l));
    if (versionLine) {
      const vm = versionLine.match(/:\s*["']?([\d.]+)["']?/);
      if (vm) version = vm[1];
    }

    const operations = this.parseYamlPaths(lines, sectionRange('paths'), indentOf);
    const schemas = this.parseYamlSchemas(lines, sectionRange('components'), sectionRange('definitions'), indentOf);

    return { relativePath, title, version, operations, schemas };
  }

  private parseYamlPaths(
    lines: string[],
    range: [number, number] | null,
    indentOf: (l: string) => number
  ): OpenApiOperation[] {
    const operations: OpenApiOperation[] = [];
    if (!range) return operations;
    const [start, end] = range;

    let currentPath: string | undefined;
    let pathIndent = -1;
    let currentOp: OpenApiOperation | null = null;
    let opIndent = -1;
    const refs = new Set<string>();

    const flushOp = () => {
      if (currentOp) {
        currentOp.refs = [...refs];
        operations.push(currentOp);
        refs.clear();
      }
      currentOp = null;
    };

    for (let i = start + 1; i < end; i++) {
      const line = lines[i];
      if (line.trim() === '' || line.trim().startsWith('#')) continue;
      const indent = indentOf(line);
      const trimmed = line.trim();


      const pathMatch = trimmed.match(/^(\/[^:]*)\s*:\s*$/);
      if (pathMatch && (pathIndent === -1 || indent <= pathIndent)) {
        flushOp();
        currentPath = pathMatch[1];
        pathIndent = indent;
        opIndent = -1;
        continue;
      }


      const methodMatch = trimmed.match(/^(get|post|put|delete|patch|head|options|trace)\s*:\s*$/i);
      if (methodMatch && currentPath && indent > pathIndent) {
        flushOp();
        opIndent = indent;
        currentOp = {
          method: methodMatch[1].toLowerCase(),
          apiPath: currentPath,
          tags: [],
          refs: [],
        };
        continue;
      }

      if (currentOp && indent > opIndent) {
        const idMatch = trimmed.match(/^operationId\s*:\s*["']?(.+?)["']?\s*$/);
        if (idMatch) currentOp.operationId = idMatch[1];
        const sumMatch = trimmed.match(/^summary\s*:\s*["']?(.+?)["']?\s*$/);
        if (sumMatch) currentOp.summary = sumMatch[1];
        const tagMatch = trimmed.match(/^-\s+["']?(.+?)["']?\s*$/);
        if (tagMatch && lines.slice(Math.max(start, i - 3), i).some(l => /tags\s*:/.test(l))) {
          currentOp.tags.push(tagMatch[1]);
        }
        const refMatch = trimmed.match(/\$ref\s*:\s*["']?(#\/[^"'\s]+)["']?/);
        if (refMatch) {
          const name = this.refName(refMatch[1]);
          if (name) refs.add(name);
        }
      } else if (currentOp && indent <= opIndent && !methodMatch && !pathMatch) {
        flushOp();
      }
    }
    flushOp();
    return operations;
  }

  private parseYamlSchemas(
    lines: string[],
    componentsRange: [number, number] | null,
    definitionsRange: [number, number] | null,
    indentOf: (l: string) => number
  ): OpenApiSchema[] {
    const schemas: OpenApiSchema[] = [];


    let blockStart = -1;
    let blockEnd = -1;
    let schemaKeyIndent = -1;

    if (componentsRange) {
      const [cStart, cEnd] = componentsRange;
      for (let i = cStart + 1; i < cEnd; i++) {
        if (/^\s+schemas\s*:\s*$/.test(lines[i])) {
          blockStart = i;
          schemaKeyIndent = indentOf(lines[i]);

          blockEnd = cEnd;
          for (let j = i + 1; j < cEnd; j++) {
            const l = lines[j];
            if (l.trim() === '' || l.trim().startsWith('#')) continue;
            if (indentOf(l) <= schemaKeyIndent) { blockEnd = j; break; }
          }
          break;
        }
      }
    }
    if (blockStart === -1 && definitionsRange) {
      blockStart = definitionsRange[0];
      blockEnd = definitionsRange[1];
      schemaKeyIndent = indentOf(lines[blockStart]);
    }
    if (blockStart === -1) return schemas;


    let nameIndent = -1;
    for (let i = blockStart + 1; i < blockEnd; i++) {
      const l = lines[i];
      if (l.trim() === '' || l.trim().startsWith('#')) continue;
      nameIndent = indentOf(l);
      break;
    }
    if (nameIndent === -1) return schemas;

    let current: { name: string; start: number } | null = null;
    const finalize = (endLine: number) => {
      if (!current) return;
      const body = lines.slice(current.start + 1, endLine);
      schemas.push(this.parseYamlSchemaBody(current.name, body, indentOf));
    };

    for (let i = blockStart + 1; i < blockEnd; i++) {
      const l = lines[i];
      if (l.trim() === '' || l.trim().startsWith('#')) continue;
      const indent = indentOf(l);
      if (indent === nameIndent) {
        const nameMatch = l.trim().match(/^([A-Za-z0-9_.-]+)\s*:\s*$/);
        if (nameMatch) {
          finalize(i);
          current = { name: nameMatch[1], start: i };
        }
      }
    }
    finalize(blockEnd);
    return schemas;
  }

  private parseYamlSchemaBody(
    name: string,
    body: string[],
    indentOf: (l: string) => number
  ): OpenApiSchema {
    const properties: OpenApiProperty[] = [];
    const refs = new Set<string>();
    const requiredNames = new Set<string>();


    let propsIndent = -1;
    let propNameIndent = -1;
    let inProps = false;
    let inRequired = false;
    let requiredIndent = -1;
    let currentProp: { name: string; indent: number } | null = null;

    for (let i = 0; i < body.length; i++) {
      const line = body[i];
      if (line.trim() === '' || line.trim().startsWith('#')) continue;
      const indent = indentOf(line);
      const trimmed = line.trim();

      if (/^properties\s*:\s*$/.test(trimmed)) {
        inProps = true; inRequired = false; propsIndent = indent; propNameIndent = -1; currentProp = null;
        continue;
      }
      if (/^required\s*:\s*$/.test(trimmed)) {
        inRequired = true; inProps = false; requiredIndent = indent;
        continue;
      }

      if (inRequired) {
        if (indent > requiredIndent) {
          const rm = trimmed.match(/^-\s+["']?(.+?)["']?\s*$/);
          if (rm) { requiredNames.add(rm[1]); continue; }
        } else {
          inRequired = false;
        }
      }

      if (inProps) {
        if (indent <= propsIndent) { inProps = false; currentProp = null; continue; }
        if (propNameIndent === -1) propNameIndent = indent;
        if (indent === propNameIndent) {
          const pm = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:\s*$/);
          const pmInline = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.+)$/);
          if (pm) {
            currentProp = { name: pm[1], indent };
            properties.push({ name: pm[1], type: 'object', required: false });
          } else if (pmInline) {
            currentProp = { name: pmInline[1], indent };
            properties.push({ name: pmInline[1], type: 'object', required: false });
          }
        } else if (currentProp && indent > propNameIndent) {
          const prop = properties[properties.length - 1];
          if (!prop) continue;
          const tm = trimmed.match(/^type\s*:\s*["']?(.+?)["']?\s*$/);
          if (tm && prop.type === 'object') prop.type = tm[1];
          const refMatch = trimmed.match(/\$ref\s*:\s*["']?(#\/[^"'\s]+)["']?/);
          if (refMatch) {
            const refName = this.refName(refMatch[1]);
            if (refName) {
              prop.ref = refName;
              prop.type = refName;
              refs.add(refName);
            }
          }
        }
      }
    }

    for (const prop of properties) {
      prop.required = requiredNames.has(prop.name);
    }

    return { name, properties, refs: [...refs] };
  }

  protected getCapabilities(): string[] {
    return ['openapi-operations', 'openapi-schemas', 'openapi-contracts'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'system';
      case 2: return 'architectural';
      case 3: return 'code';
      case 4: return 'member';
      case 5: return 'implementation';
      default: return 'unknown';
    }
  }
}
