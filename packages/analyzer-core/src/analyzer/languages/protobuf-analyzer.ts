import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  FileAnalysisResult
} from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';
import * as path from 'path';

interface ProtoField {
  name: string;
  fieldType: string;
  label?: 'repeated' | 'optional' | 'required';
  isMap: boolean;
  number: number | undefined;
  lineNumber: number;
}

interface ProtoMessage {
  name: string;
  qualifiedName: string;
  fields: ProtoField[];
  lineStart: number;
  lineEnd: number;
}

interface ProtoEnum {
  name: string;
  qualifiedName: string;
  values: Array<{ name: string; number: number | undefined; lineNumber: number }>;
  lineStart: number;
  lineEnd: number;
}

interface ProtoRpc {
  name: string;
  requestType: string;
  responseType: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
  lineNumber: number;
}

interface ProtoService {
  name: string;
  rpcs: ProtoRpc[];
  lineStart: number;
  lineEnd: number;
}

interface ProtoImport {
  rawPath: string;
  lineNumber: number;
}

interface ProtoFileInfo {
  relativePath: string;
  fullPath: string;
  packageName?: string;
  syntax?: string;
  messages: ProtoMessage[];
  enums: ProtoEnum[];
  services: ProtoService[];
  imports: ProtoImport[];
  lineCount: number;
}


const SCALAR_TYPES = new Set([
  'double', 'float', 'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64',
  'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool', 'string', 'bytes',
]);

export class ProtobufAnalyzer extends BaseAnalyzer {
  constructor() {
    super(
      'protobuf',
      'Protobuf/gRPC Analyzer',
      '1.0.0',
      'language'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const files = await this.findProtoFiles(projectPath, { projectPath }, true);
      return files.length > 0;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  incrementalContributionScope(): 'project' {
    return 'project';
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await this.findProtoFiles(projectPath, { projectPath }, false);
    return files.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    const info = this.parseProtoFile(context.relativePath, context.filePath, content);

    const messageIndex = this.buildMessageIndex([info]);

    this.emitFileNodes(info, nodes, edges, entryPoints, exitPoints, messageIndex);
    this.emitImportEdges([info], context.projectPath, edges);

    const imports = info.imports.map(imp => imp.rawPath);
    const exports = [
      ...info.messages.map(m => m.qualifiedName),
      ...info.enums.map(e => e.qualifiedName),
      ...info.services.map(s => s.name),
    ];

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
      let protoFiles = await this.findProtoFiles(context.projectPath, context, false);
      protoFiles.sort();
      protoFiles = this.capAndPrioritizeSourceFiles(protoFiles, '.proto files');

      const fileInfos: ProtoFileInfo[] = [];
      for (const relativePath of protoFiles) {
        const fullPath = path.join(context.projectPath, relativePath);
        let content = '';
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }
        fileInfos.push(this.parseProtoFile(relativePath, fullPath, content));
      }


      const messageIndex = this.buildMessageIndex(fileInfos);

      for (const info of fileInfos) {
        this.emitFileNodes(info, nodes, edges, entryPoints, exitPoints, messageIndex);
      }
      this.emitImportEdges(fileInfos, context.projectPath, edges);

      const warnings = this.collectAnalysisWarnings();
      const messageCount = nodes.filter(n => n.type === 'data-entity').length;
      const serviceCount = nodes.filter(n => n.type === 'service').length;
      const rpcCount = nodes.filter(n => n.type === 'rpc').length;
      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        ...(warnings.length > 0 ? { warnings } : {}),
        framework_specific: {
          language: 'protobuf',
          filesAnalyzed: fileInfos.length,
          messagesFound: messageCount,
          servicesFound: serviceCount,
          rpcsFound: rpcCount,
        }
      });
    } catch (error) {
      throw new AnalyzerError(
        `Protobuf analysis failed: ${(error as Error).message}`,
        'PROTOBUF_ANALYSIS_ERROR'
      );
    }
  }

  private async findProtoFiles(
    projectPath: string,
    context: AnalysisContext,
    stopEarly: boolean
  ): Promise<string[]> {
    const ignore = this.getIgnorePatterns(context);
    const files = await glob(['**/*.proto'], {
      cwd: projectPath,
      ignore,
      nodir: true
    });
    if (stopEarly && files.length > 0) return files.slice(0, 1);
    return files;
  }



  private parseProtoFile(relativePath: string, fullPath: string, content: string): ProtoFileInfo {
    const lines = content.split('\n');
    const info: ProtoFileInfo = {
      relativePath,
      fullPath,
      messages: [],
      enums: [],
      services: [],
      imports: [],
      lineCount: lines.length,
    };


    for (let i = 0; i < lines.length; i++) {
      const line = this.stripComment(lines[i]).trim();
      if (!line) continue;
      const syntaxMatch = line.match(/^syntax\s*=\s*["']([^"']+)["']\s*;/);
      if (syntaxMatch && !info.syntax) info.syntax = syntaxMatch[1];
      const pkgMatch = line.match(/^package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/);
      if (pkgMatch && !info.packageName) info.packageName = pkgMatch[1];
      const importMatch = line.match(/^import\s+(?:public\s+|weak\s+)?["']([^"']+)["']\s*;/);
      if (importMatch) info.imports.push({ rawPath: importMatch[1], lineNumber: i + 1 });
    }

    this.parseBlocks(lines, 0, lines.length, '', info);
    return info;
  }


  private parseBlocks(
    lines: string[],
    startLine: number,
    endLine: number,
    parentQualifier: string,
    info: ProtoFileInfo
  ): void {
    let i = startLine;
    while (i < endLine) {
      const raw = this.stripComment(lines[i]);
      const line = raw.trim();
      if (!line) { i++; continue; }

      const messageMatch = line.match(/^message\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{?/);
      const enumMatch = line.match(/^enum\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{?/);
      const serviceMatch = line.match(/^service\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{?/);

      if (messageMatch) {
        const name = messageMatch[1];
        const bodyEnd = this.findBlockEnd(lines, i, endLine);
        const qualifiedName = parentQualifier ? `${parentQualifier}.${name}` : name;
        const message: ProtoMessage = {
          name,
          qualifiedName,
          fields: this.extractFields(lines, i + 1, bodyEnd),
          lineStart: i + 1,
          lineEnd: bodyEnd + 1,
        };
        info.messages.push(message);

        this.parseBlocks(lines, i + 1, bodyEnd, qualifiedName, info);
        i = bodyEnd + 1;
        continue;
      }

      if (enumMatch) {
        const name = enumMatch[1];
        const bodyEnd = this.findBlockEnd(lines, i, endLine);
        const qualifiedName = parentQualifier ? `${parentQualifier}.${name}` : name;
        info.enums.push({
          name,
          qualifiedName,
          values: this.extractEnumValues(lines, i + 1, bodyEnd),
          lineStart: i + 1,
          lineEnd: bodyEnd + 1,
        });
        i = bodyEnd + 1;
        continue;
      }

      if (serviceMatch) {
        const name = serviceMatch[1];
        const bodyEnd = this.findBlockEnd(lines, i, endLine);
        info.services.push({
          name,
          rpcs: this.extractRpcs(lines, i + 1, bodyEnd),
          lineStart: i + 1,
          lineEnd: bodyEnd + 1,
        });
        i = bodyEnd + 1;
        continue;
      }

      i++;
    }
  }


  private findBlockEnd(lines: string[], startLine: number, endLine: number): number {
    let depth = 0;
    let seenOpen = false;
    for (let i = startLine; i < endLine; i++) {
      const stripped = this.stripStringsAndComments(lines[i]);
      for (const ch of stripped) {
        if (ch === '{') { depth++; seenOpen = true; }
        else if (ch === '}') {
          depth--;
          if (seenOpen && depth <= 0) return i;
        }
      }
    }
    return endLine - 1;
  }


  private extractFields(lines: string[], startLine: number, endLine: number): ProtoField[] {
    const fields: ProtoField[] = [];
    let depth = 0;
    for (let i = startLine; i < endLine; i++) {
      const stripped = this.stripStringsAndComments(lines[i]);
      const line = stripped.trim();

      const opens = (stripped.match(/\{/g) || []).length;
      const closes = (stripped.match(/\}/g) || []).length;

      if (depth === 0 && line && !/^(message|enum|oneof|reserved|option|extensions)\b/.test(line)) {
        const field = this.parseFieldLine(line, i + 1);
        if (field) fields.push(field);
      }

      depth += opens - closes;
      if (depth < 0) depth = 0;
    }
    return fields;
  }

  private parseFieldLine(line: string, lineNumber: number): ProtoField | undefined {

    const mapMatch = line.match(/^map\s*<\s*([^>]+)>\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)/);
    if (mapMatch) {
      return {
        name: mapMatch[2],
        fieldType: `map<${mapMatch[1].replace(/\s+/g, '')}>`,
        isMap: true,
        number: parseInt(mapMatch[3], 10),
        lineNumber,
      };
    }

    const fieldMatch = line.match(
      /^(?:(repeated|optional|required)\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)/
    );
    if (fieldMatch) {
      return {
        name: fieldMatch[3],
        fieldType: fieldMatch[2],
        label: fieldMatch[1] as ProtoField['label'] | undefined,
        isMap: false,
        number: parseInt(fieldMatch[4], 10),
        lineNumber,
      };
    }
    return undefined;
  }

  private extractEnumValues(
    lines: string[],
    startLine: number,
    endLine: number
  ): Array<{ name: string; number: number | undefined; lineNumber: number }> {
    const values: Array<{ name: string; number: number | undefined; lineNumber: number }> = [];
    for (let i = startLine; i < endLine; i++) {
      const line = this.stripStringsAndComments(lines[i]).trim();
      if (!line || /^(option|reserved)\b/.test(line)) continue;
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?\d+)/);
      if (match) {
        values.push({ name: match[1], number: parseInt(match[2], 10), lineNumber: i + 1 });
      }
    }
    return values;
  }

  private extractRpcs(lines: string[], startLine: number, endLine: number): ProtoRpc[] {
    const rpcs: ProtoRpc[] = [];

    const segment = lines.slice(startLine, endLine).map(l => this.stripStringsAndComments(l)).join('\n');
    const rpcRegex =
      /rpc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*(stream\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*\)\s*returns\s*\(\s*(stream\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = rpcRegex.exec(segment)) !== null) {
      const beforeMatch = segment.slice(0, match.index);
      const lineNumber = startLine + (beforeMatch.match(/\n/g) || []).length + 1;
      rpcs.push({
        name: match[1],
        clientStreaming: !!match[2],
        requestType: match[3],
        serverStreaming: !!match[4],
        responseType: match[5],
        lineNumber,
      });
    }
    return rpcs;
  }




  private buildMessageIndex(fileInfos: ProtoFileInfo[]): Map<string, string> {
    const index = new Map<string, string>();
    for (const info of fileInfos) {
      const pkg = info.packageName;
      for (const m of info.messages) {
        const id = this.messageId(info.relativePath, m.qualifiedName, m.lineStart);
        this.registerTypeName(index, m.qualifiedName, pkg, id);
      }
      for (const e of info.enums) {
        const id = this.enumId(info.relativePath, e.qualifiedName, e.lineStart);
        this.registerTypeName(index, e.qualifiedName, pkg, id);
      }
    }
    return index;
  }

  private registerTypeName(
    index: Map<string, string>,
    qualifiedName: string,
    pkg: string | undefined,
    nodeId: string
  ): void {
    const simple = qualifiedName.split('.').pop()!;

    if (!index.has(simple)) index.set(simple, nodeId);
    index.set(qualifiedName, nodeId);
    if (pkg) {
      index.set(`${pkg}.${qualifiedName}`, nodeId);
      index.set(`.${pkg}.${qualifiedName}`, nodeId);
    }
  }

  private resolveTypeName(
    typeName: string,
    info: ProtoFileInfo,
    index: Map<string, string>
  ): string | undefined {
    if (SCALAR_TYPES.has(typeName)) return undefined;
    const candidates = [
      typeName,
      typeName.replace(/^\./, ''),
      info.packageName ? `${info.packageName}.${typeName}` : undefined,
      typeName.split('.').pop(),
    ].filter((c): c is string => !!c);
    for (const c of candidates) {
      const hit = index.get(c);
      if (hit) return hit;
    }
    return undefined;
  }



  private emitFileNodes(
    info: ProtoFileInfo,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    messageIndex: Map<string, string>
  ): void {
    const fileId = this.fileId(info.relativePath);
    const baseName = info.relativePath.split('/').pop() || 'unknown.proto';

    nodes.push(this.createNodeBuilder(fileId, baseName, 'file')
      .withLevel(1, 'File/Module')
      .withCategory('modules', ['protobuf-files'])
      .withSource({ file: info.fullPath, line: 1, end_line: info.lineCount })
      .withMetadata({
        language: 'protobuf',
        attributes: {
          package: info.packageName,
          syntax: info.syntax,
          messageCount: info.messages.length,
          enumCount: info.enums.length,
          serviceCount: info.services.length,
          importCount: info.imports.length,
        }
      })
      .build());


    for (const message of info.messages) {
      const messageId = this.messageId(info.relativePath, message.qualifiedName, message.lineStart);
      const node = this.createNodeBuilder(messageId, message.name, 'data-entity')
        .withLevel(2, 'Data Entity')
        .withCategory('data', ['protobuf-messages'])
        .withSource({ file: info.fullPath, line: message.lineStart, end_line: message.lineEnd })
        .withMetadata({
          language: 'protobuf',
          attributes: {
            package: info.packageName,
            qualifiedName: message.qualifiedName,
            fieldCount: message.fields.length,
            file: info.relativePath,
          }
        })
        .build();
      node.qualified_name = info.packageName
        ? `${info.packageName}.${message.qualifiedName}`
        : message.qualifiedName;
      nodes.push(node);

      edges.push(this.createEdge(
        `${fileId}_contains_${messageId}`,
        fileId,
        messageId,
        'contains'
      ));

      for (const field of message.fields) {
        const fieldId = this.fieldId(info.relativePath, message.qualifiedName, field.name, field.lineNumber);
        const fieldNode = this.createNodeBuilder(fieldId, field.name, 'field')
          .withLevel(4, 'Field')
          .withCategory('data', ['protobuf-fields'])
          .withSource({ file: info.fullPath, line: field.lineNumber, end_line: field.lineNumber })
          .withMetadata({
            language: 'protobuf',
            attributes: {
              fieldType: field.fieldType,
              fieldNumber: field.number,
              label: field.label,
              isMap: field.isMap,
              repeated: field.label === 'repeated',
              optional: field.label === 'optional',
              message: message.qualifiedName,
            }
          })
          .build();
        fieldNode.qualified_name = `${message.qualifiedName}.${field.name}`;
        nodes.push(fieldNode);

        edges.push(this.createEdge(
          `${messageId}_has_field_${fieldId}`,
          messageId,
          fieldId,
          'contains'
        ));


        const referencedId = this.resolveTypeName(field.fieldType, info, messageIndex);
        if (referencedId && referencedId !== messageId) {
          edges.push(this.createEdge(
            `ref_${messageId}_${fieldId}_to_${referencedId}`,
            messageId,
            referencedId,
            'references',
            'data',
            { field: field.name, fieldType: field.fieldType, line: field.lineNumber, language: 'protobuf' }
          ));
        }
      }
    }


    for (const en of info.enums) {
      const enumId = this.enumId(info.relativePath, en.qualifiedName, en.lineStart);
      const node = this.createNodeBuilder(enumId, en.name, 'enum')
        .withLevel(2, 'Data Entity')
        .withCategory('data', ['protobuf-enums'])
        .withSource({ file: info.fullPath, line: en.lineStart, end_line: en.lineEnd })
        .withMetadata({
          language: 'protobuf',
          attributes: {
            package: info.packageName,
            qualifiedName: en.qualifiedName,
            values: en.values.map(v => v.name),
            valueCount: en.values.length,
            file: info.relativePath,
          }
        })
        .build();
      node.qualified_name = info.packageName
        ? `${info.packageName}.${en.qualifiedName}`
        : en.qualifiedName;
      nodes.push(node);

      edges.push(this.createEdge(
        `${fileId}_contains_${enumId}`,
        fileId,
        enumId,
        'contains'
      ));
    }


    for (const service of info.services) {
      const serviceId = this.serviceId(info.relativePath, service.name, service.lineStart);
      nodes.push(this.createNodeBuilder(serviceId, service.name, 'service')
        .withLevel(2, 'Service')
        .withCategory('services', ['protobuf-services'])
        .withSource({ file: info.fullPath, line: service.lineStart, end_line: service.lineEnd })
        .withMetadata({
          language: 'protobuf',
          attributes: {
            package: info.packageName,
            rpcCount: service.rpcs.length,
            rpcs: service.rpcs.map(r => r.name),
            file: info.relativePath,
          }
        })
        .build());

      edges.push(this.createEdge(
        `${fileId}_contains_${serviceId}`,
        fileId,
        serviceId,
        'contains'
      ));

      for (const rpc of service.rpcs) {
        const rpcId = this.rpcId(info.relativePath, service.name, rpc.name, rpc.lineNumber);
        const streamingMode =
          rpc.clientStreaming && rpc.serverStreaming ? 'bidirectional'
          : rpc.clientStreaming ? 'client'
          : rpc.serverStreaming ? 'server'
          : 'unary';
        const rpcNode = this.createNodeBuilder(rpcId, rpc.name, 'rpc')
          .withLevel(3, 'RPC')
          .withCategory('endpoints', ['grpc-rpcs'])
          .withSource({ file: info.fullPath, line: rpc.lineNumber, end_line: rpc.lineNumber })
          .withMetadata({
            language: 'protobuf',
            attributes: {
              service: service.name,
              package: info.packageName,
              requestType: rpc.requestType,
              responseType: rpc.responseType,
              clientStreaming: rpc.clientStreaming,
              serverStreaming: rpc.serverStreaming,
              streaming: streamingMode,
              file: info.relativePath,
            }
          })
          .build();
        rpcNode.qualified_name = info.packageName
          ? `${info.packageName}.${service.name}.${rpc.name}`
          : `${service.name}.${rpc.name}`;
        nodes.push(rpcNode);

        edges.push(this.createEdge(
          `${serviceId}_defines_${rpcId}`,
          serviceId,
          rpcId,
          'contains'
        ));


        const requestId = this.resolveTypeName(rpc.requestType, info, messageIndex);
        if (requestId) {
          edges.push(this.createEdge(
            `rpc_${rpcId}_accepts_${requestId}`,
            rpcId,
            requestId,
            'references',
            'data',
            { role: 'request', type: rpc.requestType, clientStreaming: rpc.clientStreaming, language: 'protobuf' }
          ));
        }
        const responseId = this.resolveTypeName(rpc.responseType, info, messageIndex);
        if (responseId) {
          edges.push(this.createEdge(
            `rpc_${rpcId}_returns_${responseId}`,
            rpcId,
            responseId,
            'references',
            'data',
            { role: 'response', type: rpc.responseType, serverStreaming: rpc.serverStreaming, language: 'protobuf' }
          ));
        }


        const fullPath = info.packageName
          ? `/${info.packageName}.${service.name}/${rpc.name}`
          : `/${service.name}/${rpc.name}`;
        entryPoints.push(this.createEntryPoint(
          `entry_${rpcId}`,
          rpcId,
          'http',
          `gRPC ${service.name}.${rpc.name}`,
          `gRPC RPC (${streamingMode}) ${rpc.requestType} -> ${rpc.responseType}`,
          { method: 'POST', path: fullPath, pattern: streamingMode },
          undefined,
          {
            protocol: 'grpc',
            service: service.name,
            rpc: rpc.name,
            package: info.packageName,
            requestType: rpc.requestType,
            responseType: rpc.responseType,
            clientStreaming: rpc.clientStreaming,
            serverStreaming: rpc.serverStreaming,
            streaming: streamingMode,
            file: info.relativePath,
            line: rpc.lineNumber,
          },
          { node_id: rpcId, method_name: rpc.name, file: info.relativePath, line: rpc.lineNumber }
        ));
      }
    }
  }

  private emitImportEdges(
    fileInfos: ProtoFileInfo[],
    projectPath: string,
    edges: CASEdge[]
  ): void {
    const edgeIds = new Set(edges.map(e => e.id));
    const byRelative = new Map<string, ProtoFileInfo>();
    const byBasename = new Map<string, ProtoFileInfo>();
    for (const info of fileInfos) {
      byRelative.set(this.normalize(info.relativePath), info);
      byBasename.set(path.basename(info.relativePath), info);
    }

    for (const info of fileInfos) {
      const sourceDir = path.dirname(info.fullPath);
      for (const imp of info.imports) {
        const target = this.resolveImport(imp.rawPath, sourceDir, projectPath, byRelative, byBasename);
        if (!target) continue;
        const sourceId = this.fileId(info.relativePath);
        const targetId = this.fileId(target.relativePath);
        if (sourceId === targetId) continue;
        const edgeId = `${sourceId}_imports_${targetId}_${imp.lineNumber}`;
        if (edgeIds.has(edgeId)) continue;
        edgeIds.add(edgeId);
        edges.push(this.createEdge(
          edgeId,
          sourceId,
          targetId,
          'imports',
          'dependency',
          { line: imp.lineNumber, rawPath: imp.rawPath, language: 'protobuf' }
        ));
      }
    }
  }

  private resolveImport(
    rawPath: string,
    sourceDir: string,
    projectPath: string,
    byRelative: Map<string, ProtoFileInfo>,
    byBasename: Map<string, ProtoFileInfo>
  ): ProtoFileInfo | undefined {

    const rootRel = this.normalize(rawPath);
    if (byRelative.has(rootRel)) return byRelative.get(rootRel);


    const abs = path.resolve(sourceDir, rawPath);
    const rel = this.normalize(path.relative(projectPath, abs));
    if (byRelative.has(rel)) return byRelative.get(rel);


    for (const [key, info] of byRelative) {
      if (key.endsWith(`/${rootRel}`)) return info;
    }


    return byBasename.get(path.basename(rawPath));
  }



  private stripComment(line: string): string {
    const idx = this.commentIndex(line);
    return idx === -1 ? line : line.slice(0, idx);
  }

  private commentIndex(line: string): number {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
      else if (ch === '/' && line[i + 1] === '/' && !inSingle && !inDouble) return i;
    }
    return -1;
  }

  private stripStringsAndComments(line: string): string {
    let result = '';
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
      if (ch === '/' && line[i + 1] === '/' && !inSingle && !inDouble) break;
      if (!inSingle && !inDouble) result += ch;
    }
    return result;
  }



  private fileId(relativePath: string): string {
    return `file_${this.sanitizeId(relativePath)}`;
  }

  private messageId(relativePath: string, qualifiedName: string, line: number): string {
    return `message_${this.sanitizeId(relativePath)}_${this.sanitizeId(qualifiedName)}_${line}`;
  }

  private enumId(relativePath: string, qualifiedName: string, line: number): string {
    return `enum_${this.sanitizeId(relativePath)}_${this.sanitizeId(qualifiedName)}_${line}`;
  }

  private fieldId(relativePath: string, message: string, name: string, line: number): string {
    return `field_${this.sanitizeId(relativePath)}_${this.sanitizeId(message)}_${this.sanitizeId(name)}_${line}`;
  }

  private serviceId(relativePath: string, name: string, line: number): string {
    return `service_${this.sanitizeId(relativePath)}_${this.sanitizeId(name)}_${line}`;
  }

  private rpcId(relativePath: string, service: string, name: string, line: number): string {
    return `rpc_${this.sanitizeId(relativePath)}_${this.sanitizeId(service)}_${this.sanitizeId(name)}_${line}`;
  }

  private normalize(relativePath: string): string {
    return relativePath.replace(/\\/g, '/');
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

  protected getCapabilities(): string[] {
    return [
      'protobuf-messages',
      'protobuf-services',
      'grpc-rpcs',
      'protobuf-imports',
    ];
  }
}
