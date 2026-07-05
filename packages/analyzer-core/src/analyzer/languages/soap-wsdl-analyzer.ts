import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  FileAnalysisResult
} from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import { XMLParser } from 'fast-xml-parser';
import * as fs from 'fs-extra';
import { glob } from 'glob';
import * as path from 'path';

interface WsdlMessagePart {
  name: string;
  element?: string;
  type?: string;
}

interface WsdlMessage {
  name: string;
  parts: WsdlMessagePart[];
}

interface WsdlOperation {
  name: string;
  inputMessage?: string;
  outputMessage?: string;
}

interface WsdlPortType {
  name: string;
  operations: WsdlOperation[];
}

interface WsdlBindingOperation {
  name: string;
  soapAction?: string;
}

interface WsdlBinding {
  name: string;
  type?: string;
  protocol?: 'soap11' | 'soap12';
  style?: string;
  operations: WsdlBindingOperation[];
}

interface WsdlPort {
  name: string;
  binding?: string;
  address?: string;
}

interface WsdlService {
  name: string;
  ports: WsdlPort[];
}

interface XsdType {
  name: string;
  kind: 'element' | 'complexType' | 'simpleType';
  namespace?: string;
  fields: string[];
  relativePath: string;
}

interface WsdlFileInfo {
  relativePath: string;
  fullPath: string;
  targetNamespace?: string;
  services: WsdlService[];
  portTypes: WsdlPortType[];
  bindings: WsdlBinding[];
  messages: WsdlMessage[];
  types: XsdType[];
}

interface XsdFileInfo {
  relativePath: string;
  fullPath: string;
  targetNamespace?: string;
  types: XsdType[];
}

interface SoapConsumer {
  relativePath: string;
  fullPath: string;
  line: number;
  library: string;
  operation?: string;
  service?: string;
  endpoint?: string;
  evidence: string;
}

export class SoapWsdlAnalyzer extends BaseAnalyzer {
  private readonly parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
  });

  constructor() {
    super(
      'soap-wsdl',
      'SOAP/WSDL Analyzer',
      '1.0.0',
      'language'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const contractFiles = await this.findContractFiles(projectPath, { projectPath }, true);
      if (contractFiles.length > 0) return true;
      const consumerFiles = await this.findSoapConsumerFiles(projectPath, { projectPath }, true);
      return consumerFiles.length > 0;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const contractFiles = await this.findContractFiles(projectPath, { projectPath }, false);
    const consumerFiles = await this.findSoapConsumerFiles(projectPath, { projectPath }, false);
    return Array.from(new Set([...contractFiles, ...consumerFiles])).sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);
    const lower = context.relativePath.toLowerCase();

    if (lower.endsWith('.wsdl')) {
      const info = this.parseWsdlFile(context.relativePath, context.filePath, content);
      this.emitWsdlFile(info, nodes, edges, entryPoints);
    } else if (lower.endsWith('.xsd')) {
      const info = this.parseXsdFile(context.relativePath, context.filePath, content);
      this.emitXsdFile(info, nodes, edges);
    } else {
      for (const consumer of this.extractConsumers(context.relativePath, context.filePath, content)) {
        this.emitConsumerExitPoint(consumer, exitPoints);
      }
    }

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
      nodes.map(n => n.qualified_name || n.name)
    );
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    this.resetAnalysisWarnings();
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      let contractFiles = await this.findContractFiles(context.projectPath, context, false);
      contractFiles.sort();
      contractFiles = this.capAndPrioritizeSourceFiles(contractFiles, 'SOAP/WSDL contract files');

      const wsdlFiles: WsdlFileInfo[] = [];
      const xsdFiles: XsdFileInfo[] = [];
      for (const relativePath of contractFiles) {
        const fullPath = path.join(context.projectPath, relativePath);
        const content = await this.readText(fullPath);
        if (content === null) continue;
        if (relativePath.toLowerCase().endsWith('.wsdl')) {
          wsdlFiles.push(this.parseWsdlFile(relativePath, fullPath, content));
        } else {
          xsdFiles.push(this.parseXsdFile(relativePath, fullPath, content));
        }
      }

      const externalTypes = new Map<string, string>();
      for (const info of xsdFiles) {
        this.emitXsdFile(info, nodes, edges, externalTypes);
      }
      for (const info of wsdlFiles) {
        this.emitWsdlFile(info, nodes, edges, entryPoints, externalTypes);
      }

      let consumerFiles = await this.findSoapConsumerFiles(context.projectPath, context, false);
      consumerFiles = consumerFiles.filter(file => !contractFiles.includes(file)).sort();
      consumerFiles = this.capAndPrioritizeSourceFiles(consumerFiles, 'SOAP consumer source files');
      for (const relativePath of consumerFiles) {
        const fullPath = path.join(context.projectPath, relativePath);
        const content = await this.readText(fullPath);
        if (content === null) continue;
        for (const consumer of this.extractConsumers(relativePath, fullPath, content)) {
          this.emitConsumerExitPoint(consumer, exitPoints);
        }
      }

      const warnings = this.collectAnalysisWarnings();
      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        ...(warnings.length > 0 ? { warnings } : {}),
        framework_specific: {
          language: 'soap-wsdl',
          wsdlFilesAnalyzed: wsdlFiles.length,
          xsdFilesAnalyzed: xsdFiles.length,
          servicesFound: wsdlFiles.reduce((sum, info) => sum + info.services.length, 0),
          operationsFound: wsdlFiles.reduce((sum, info) => sum + info.portTypes.reduce((inner, portType) => inner + portType.operations.length, 0), 0),
          schemaTypesFound: nodes.filter(n => n.type === 'data-entity' && n.metadata?.language === 'xsd').length,
          consumerExitPointsFound: exitPoints.length,
        }
      });
    } catch (error) {
      throw new AnalyzerError(
        `SOAP/WSDL analysis failed: ${(error as Error).message}`,
        'SOAP_WSDL_ANALYSIS_ERROR'
      );
    }
  }

  private async findContractFiles(
    projectPath: string,
    context: AnalysisContext,
    stopEarly: boolean
  ): Promise<string[]> {
    const files = await glob(['**/*.{wsdl,xsd}'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns(context),
      nodir: true,
      nocase: true,
    });
    if (stopEarly && files.length > 0) return files.slice(0, 1);
    return files;
  }

  private async findSoapConsumerFiles(
    projectPath: string,
    context: AnalysisContext,
    stopEarly: boolean
  ): Promise<string[]> {
    const candidates = await glob(['**/*.{ts,tsx,js,jsx,py,java,cs,rb}'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns(context),
      nodir: true,
    });
    const hits: string[] = [];
    for (const relativePath of candidates) {
      const content = await this.readText(path.join(projectPath, relativePath));
      if (content === null) continue;
      if (this.hasSoapConsumerEvidence(relativePath, content)) {
        hits.push(relativePath);
        if (stopEarly) return hits;
      }
    }
    return hits;
  }

  private async readText(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  private parseWsdlFile(relativePath: string, fullPath: string, content: string): WsdlFileInfo {
    const parsed = this.parser.parse(content);
    const definitions = this.first(parsed.definitions || parsed.description || parsed);
    const typesRoot = this.first(definitions?.types);
    const schemas = this.toArray(typesRoot?.schema);

    return {
      relativePath,
      fullPath,
      targetNamespace: this.stringAttr(definitions?.targetNamespace),
      services: this.toArray(definitions?.service).map(service => this.parseService(service)),
      portTypes: this.toArray(definitions?.portType).map(portType => this.parsePortType(portType)),
      bindings: this.toArray(definitions?.binding).map(binding => this.parseBinding(binding)),
      messages: this.toArray(definitions?.message).map(message => this.parseMessage(message)),
      types: schemas.flatMap(schema => this.parseSchemaTypes(schema, relativePath)),
    };
  }

  private parseXsdFile(relativePath: string, fullPath: string, content: string): XsdFileInfo {
    const parsed = this.parser.parse(content);
    const schema = this.first(parsed.schema || parsed);
    return {
      relativePath,
      fullPath,
      targetNamespace: this.stringAttr(schema?.targetNamespace),
      types: this.parseSchemaTypes(schema, relativePath),
    };
  }

  private parseService(service: any): WsdlService {
    return {
      name: this.stringAttr(service?.name) || 'unnamed-service',
      ports: this.toArray(service?.port).map(port => ({
        name: this.stringAttr(port?.name) || 'unnamed-port',
        binding: this.localName(this.stringAttr(port?.binding)),
        address: this.stringAttr(this.first(port?.address)?.location),
      })),
    };
  }

  private parsePortType(portType: any): WsdlPortType {
    return {
      name: this.stringAttr(portType?.name) || 'unnamed-portType',
      operations: this.toArray(portType?.operation).map(operation => ({
        name: this.stringAttr(operation?.name) || 'unnamed-operation',
        inputMessage: this.localName(this.stringAttr(this.first(operation?.input)?.message)),
        outputMessage: this.localName(this.stringAttr(this.first(operation?.output)?.message)),
      })),
    };
  }

  private parseBinding(binding: any): WsdlBinding {
    const soapBinding = this.first(binding?.binding);
    return {
      name: this.stringAttr(binding?.name) || 'unnamed-binding',
      type: this.localName(this.stringAttr(binding?.type)),
      protocol: this.soapProtocol(soapBinding),
      style: this.stringAttr(soapBinding?.style),
      operations: this.toArray(binding?.operation).map(operation => {
        const soapOperation = this.first(operation?.operation);
        return {
          name: this.stringAttr(operation?.name) || 'unnamed-operation',
          soapAction: this.stringAttr(soapOperation?.soapAction),
        };
      }),
    };
  }

  private parseMessage(message: any): WsdlMessage {
    return {
      name: this.stringAttr(message?.name) || 'unnamed-message',
      parts: this.toArray(message?.part).map(part => ({
        name: this.stringAttr(part?.name) || 'part',
        element: this.localName(this.stringAttr(part?.element)),
        type: this.localName(this.stringAttr(part?.type)),
      })),
    };
  }

  private parseSchemaTypes(schema: any, relativePath: string): XsdType[] {
    if (!schema) return [];
    const namespace = this.stringAttr(schema.targetNamespace);
    const types: XsdType[] = [];
    for (const element of this.toArray(schema.element)) {
      const name = this.stringAttr(element?.name);
      if (!name) continue;
      types.push({
        name,
        kind: 'element',
        namespace,
        fields: this.extractXsdFields(element),
        relativePath,
      });
    }
    for (const complexType of this.toArray(schema.complexType)) {
      const name = this.stringAttr(complexType?.name);
      if (!name) continue;
      types.push({
        name,
        kind: 'complexType',
        namespace,
        fields: this.extractXsdFields(complexType),
        relativePath,
      });
    }
    for (const simpleType of this.toArray(schema.simpleType)) {
      const name = this.stringAttr(simpleType?.name);
      if (!name) continue;
      types.push({
        name,
        kind: 'simpleType',
        namespace,
        fields: [],
        relativePath,
      });
    }
    return types;
  }

  private extractXsdFields(node: any): string[] {
    const sequence = this.first(node?.complexType)?.sequence || node?.sequence;
    const all = this.first(node?.complexType)?.all || node?.all;
    const choice = this.first(node?.complexType)?.choice || node?.choice;
    return [
      ...this.toArray(this.first(sequence)?.element),
      ...this.toArray(this.first(all)?.element),
      ...this.toArray(this.first(choice)?.element),
    ].map(field => this.stringAttr(field?.name)).filter((name): name is string => !!name);
  }

  private emitXsdFile(
    info: XsdFileInfo,
    nodes: CASNode[],
    edges: CASEdge[],
    typeIndex?: Map<string, string>
  ): void {
    const fileId = this.fileId(info.relativePath);
    const baseName = path.basename(info.relativePath);
    nodes.push(this.createNodeBuilder(fileId, baseName, 'file')
      .withLevel(1, 'File/Module')
      .withCategory('modules', ['xsd-files'])
      .withSource({ file: info.fullPath, line: 1 })
      .withMetadata({
        language: 'xsd',
        attributes: {
          targetNamespace: info.targetNamespace,
          typeCount: info.types.length,
        }
      })
      .build());

    for (const type of info.types) {
      this.emitXsdType(info.fullPath, fileId, type, nodes, edges, typeIndex);
    }
  }

  private emitWsdlFile(
    info: WsdlFileInfo,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    externalTypes?: Map<string, string>
  ): void {
    const fileId = this.fileId(info.relativePath);
    const messageIndex = this.buildMessageIndex(info);
    const typeIndex = new Map<string, string>(externalTypes || []);

    nodes.push(this.createNodeBuilder(fileId, path.basename(info.relativePath), 'file')
      .withLevel(1, 'File/Module')
      .withCategory('modules', ['wsdl-files'])
      .withSource({ file: info.fullPath, line: 1 })
      .withMetadata({
        language: 'wsdl',
        attributes: {
          targetNamespace: info.targetNamespace,
          serviceCount: info.services.length,
          portTypeCount: info.portTypes.length,
          bindingCount: info.bindings.length,
          messageCount: info.messages.length,
          schemaTypeCount: info.types.length,
        }
      })
      .build());

    for (const type of info.types) {
      this.emitXsdType(info.fullPath, fileId, type, nodes, edges, typeIndex);
    }

    for (const message of info.messages) {
      const messageId = this.messageId(info.relativePath, message.name);
      const messageNode = this.createNodeBuilder(messageId, message.name, 'data-entity')
        .withLevel(2, 'Data Entity')
        .withCategory('data', ['wsdl-messages'])
        .withSource({ file: info.fullPath, line: 1 })
        .withMetadata({
          language: 'wsdl',
          attributes: {
            targetNamespace: info.targetNamespace,
            parts: message.parts,
            partCount: message.parts.length,
            file: info.relativePath,
          }
        })
        .build();
      messageNode.qualified_name = info.targetNamespace ? `${info.targetNamespace}#${message.name}` : message.name;
      nodes.push(messageNode);
      edges.push(this.createEdge(`${fileId}_contains_${messageId}`, fileId, messageId, 'contains'));

      for (const part of message.parts) {
        const referenced = part.element || part.type;
        const typeId = referenced ? this.resolveTypeId(referenced, typeIndex) : undefined;
        if (typeId) {
          edges.push(this.createEdge(
            `message_${messageId}_part_${this.sanitizeId(part.name)}_type_${typeId}`,
            messageId,
            typeId,
            'references',
            'data',
            { role: 'message-part', part: part.name, type: referenced, language: 'wsdl' }
          ));
        }
      }
    }

    for (const service of info.services) {
      const serviceId = this.serviceId(info.relativePath, service.name);
      nodes.push(this.createNodeBuilder(serviceId, service.name, 'soap_service')
        .withLevel(2, 'Service')
        .withCategory('services', ['soap-services'])
        .withSource({ file: info.fullPath, line: 1 })
        .withMetadata({
          language: 'wsdl',
          attributes: {
            targetNamespace: info.targetNamespace,
            ports: service.ports,
            file: info.relativePath,
          }
        })
        .build());
      edges.push(this.createEdge(`${fileId}_contains_${serviceId}`, fileId, serviceId, 'contains'));

      for (const port of service.ports) {
        const binding = info.bindings.find(candidate => candidate.name === port.binding);
        const portType = info.portTypes.find(candidate => candidate.name === binding?.type);
        if (!binding || !portType) continue;
        for (const operation of portType.operations) {
          this.emitSoapOperation(info, service, port, binding, operation, serviceId, messageIndex, nodes, edges, entryPoints);
        }
      }
    }
  }

  private emitXsdType(
    fullPath: string,
    fileId: string,
    type: XsdType,
    nodes: CASNode[],
    edges: CASEdge[],
    typeIndex?: Map<string, string>
  ): void {
    const typeId = this.xsdTypeId(type.relativePath, type.kind, type.name);
    if (typeIndex) this.registerType(typeIndex, type.name, type.namespace, typeId);
    const node = this.createNodeBuilder(typeId, type.name, 'data-entity')
      .withLevel(2, 'Data Entity')
      .withCategory('data', ['xsd-types', `xsd-${type.kind}`])
      .withSource({ file: fullPath, line: 1 })
      .withMetadata({
        language: 'xsd',
        attributes: {
          kind: type.kind,
          targetNamespace: type.namespace,
          fields: type.fields,
          fieldCount: type.fields.length,
          file: type.relativePath,
        }
      })
      .build();
    node.qualified_name = type.namespace ? `${type.namespace}#${type.name}` : type.name;
    nodes.push(node);
    edges.push(this.createEdge(`${fileId}_contains_${typeId}`, fileId, typeId, 'contains'));
  }

  private emitSoapOperation(
    info: WsdlFileInfo,
    service: WsdlService,
    port: WsdlPort,
    binding: WsdlBinding,
    operation: WsdlOperation,
    serviceId: string,
    messageIndex: Map<string, string>,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const operationId = this.operationId(info.relativePath, service.name, port.name, operation.name);
    const bindingOperation = binding.operations.find(candidate => candidate.name === operation.name);
    const operationNode = this.createNodeBuilder(operationId, operation.name, 'soap_operation')
      .withLevel(3, 'SOAP Operation')
      .withCategory('endpoints', ['soap-operations'])
      .withSource({ file: info.fullPath, line: 1 })
      .withMetadata({
        language: 'wsdl',
        attributes: {
          service: service.name,
          port: port.name,
          binding: binding.name,
          portType: binding.type,
          protocol: binding.protocol,
          style: binding.style,
          soapAction: bindingOperation?.soapAction,
          address: port.address,
          inputMessage: operation.inputMessage,
          outputMessage: operation.outputMessage,
          targetNamespace: info.targetNamespace,
          file: info.relativePath,
        }
      })
      .build();
    operationNode.qualified_name = `${service.name}.${port.name}.${operation.name}`;
    nodes.push(operationNode);

    edges.push(this.createEdge(`${serviceId}_defines_${operationId}`, serviceId, operationId, 'contains'));
    const inputId = operation.inputMessage ? messageIndex.get(operation.inputMessage) : undefined;
    if (inputId) {
      edges.push(this.createEdge(
        `soap_${operationId}_accepts_${inputId}`,
        operationId,
        inputId,
        'references',
        'data',
        { role: 'request', message: operation.inputMessage, language: 'wsdl' }
      ));
    }
    const outputId = operation.outputMessage ? messageIndex.get(operation.outputMessage) : undefined;
    if (outputId) {
      edges.push(this.createEdge(
        `soap_${operationId}_returns_${outputId}`,
        operationId,
        outputId,
        'references',
        'data',
        { role: 'response', message: operation.outputMessage, language: 'wsdl' }
      ));
    }

    entryPoints.push(this.createEntryPoint(
      `entry_${operationId}`,
      operationId,
      'api',
      `SOAP ${service.name}.${operation.name}`,
      `SOAP operation ${operation.name}`,
      { method: 'POST', path: port.address, pattern: binding.protocol || 'soap' },
      undefined,
      {
        protocol: 'soap',
        service: service.name,
        port: port.name,
        operation: operation.name,
        binding: binding.name,
        soapAction: bindingOperation?.soapAction,
        inputMessage: operation.inputMessage,
        outputMessage: operation.outputMessage,
        targetNamespace: info.targetNamespace,
        file: info.relativePath,
      },
      { node_id: operationId, method_name: operation.name, file: info.relativePath, line: 1 }
    ));
  }

  private buildMessageIndex(info: WsdlFileInfo): Map<string, string> {
    const index = new Map<string, string>();
    for (const message of info.messages) {
      const id = this.messageId(info.relativePath, message.name);
      index.set(message.name, id);
      if (info.targetNamespace) index.set(`${info.targetNamespace}#${message.name}`, id);
    }
    return index;
  }

  private registerType(index: Map<string, string>, name: string, namespace: string | undefined, id: string): void {
    if (!index.has(name)) index.set(name, id);
    if (namespace) {
      index.set(`${namespace}#${name}`, id);
      index.set(`${namespace}:${name}`, id);
    }
  }

  private resolveTypeId(typeName: string, index: Map<string, string>): string | undefined {
    const local = this.localName(typeName);
    return index.get(typeName) || (local ? index.get(local) : undefined);
  }

  private hasSoapConsumerEvidence(relativePath: string, content: string): boolean {
    const extension = path.extname(relativePath).toLowerCase();
    if (['.ts', '.tsx', '.js', '.jsx'].includes(extension)) {
      return /(?:from\s+['"](?:soap|strong-soap)['"]|require\(\s*['"](?:soap|strong-soap)['"]\s*\))/.test(content);
    }
    if (extension === '.py') {
      return /(?:^|\n)\s*(?:import\s+(?:zeep|suds)\b|from\s+(?:zeep|suds)(?:\.client)?\s+import\s+)/.test(content);
    }
    if (extension === '.java') {
      return /import\s+javax\.xml\.ws\.(?:WebServiceClient|WebService|Service)\s*;|import\s+jakarta\.xml\.ws\.(?:WebServiceClient|WebService|Service)\s*;|@(WebServiceClient|WebService)\b/.test(content);
    }
    if (extension === '.cs') {
      return /using\s+System\.ServiceModel\s*;|\[ServiceContract\b|ClientBase<|ChannelFactory</.test(content);
    }
    if (extension === '.rb') {
      return /(?:^|\n)\s*require\s+['"]savon['"]|Savon\.client\b/.test(content);
    }
    return false;
  }

  private extractConsumers(relativePath: string, fullPath: string, content: string): SoapConsumer[] {
    if (!this.hasSoapConsumerEvidence(relativePath, content)) return [];
    const extension = path.extname(relativePath).toLowerCase();
    if (['.ts', '.tsx', '.js', '.jsx'].includes(extension)) return this.extractNodeConsumers(relativePath, fullPath, content);
    if (extension === '.py') return this.extractPythonConsumers(relativePath, fullPath, content);
    if (extension === '.java') return this.extractJavaConsumers(relativePath, fullPath, content);
    if (extension === '.cs') return this.extractCSharpConsumers(relativePath, fullPath, content);
    if (extension === '.rb') return this.extractRubyConsumers(relativePath, fullPath, content);
    return [];
  }

  private extractNodeConsumers(relativePath: string, fullPath: string, content: string): SoapConsumer[] {
    const consumers: SoapConsumer[] = [];
    const wsdlRegex = /createClient(?:Async)?\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let match: RegExpExecArray | null;
    while ((match = wsdlRegex.exec(content)) !== null) {
      consumers.push(this.consumer(relativePath, fullPath, content, match.index, 'soap', undefined, match[1], 'createClient'));
    }
    const operationRegex = /\bclient\.([A-Za-z_][A-Za-z0-9_]*)(?:Async)?\s*\(/g;
    while ((match = operationRegex.exec(content)) !== null) {
      if (['createClient', 'createClientAsync'].includes(match[1])) continue;
      consumers.push(this.consumer(relativePath, fullPath, content, match.index, 'soap', match[1].replace(/Async$/, ''), undefined, 'client operation call'));
    }
    return consumers;
  }

  private extractPythonConsumers(relativePath: string, fullPath: string, content: string): SoapConsumer[] {
    const consumers: SoapConsumer[] = [];
    const clientRegex = /\b(?:Client|zeep\.Client)\s*\(\s*['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = clientRegex.exec(content)) !== null) {
      consumers.push(this.consumer(relativePath, fullPath, content, match.index, 'zeep/suds', undefined, match[1], 'Client'));
    }
    const operationRegex = /\bclient\.service\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    while ((match = operationRegex.exec(content)) !== null) {
      consumers.push(this.consumer(relativePath, fullPath, content, match.index, 'zeep/suds', match[1], undefined, 'client.service operation call'));
    }
    return consumers;
  }

  private extractJavaConsumers(relativePath: string, fullPath: string, content: string): SoapConsumer[] {
    const consumers: SoapConsumer[] = [];
    const clientRegex = /@WebServiceClient\s*\(([^)]*)\)/g;
    const serviceRegex = /@WebService\s*\(([^)]*)\)/g;
    let match: RegExpExecArray | null;
    while ((match = clientRegex.exec(content)) !== null) {
      const attrs = match[1];
      consumers.push(this.consumer(
        relativePath,
        fullPath,
        content,
        match.index,
        'jax-ws',
        undefined,
        this.annotationValue(attrs, 'wsdlLocation'),
        '@WebServiceClient',
        this.annotationValue(attrs, 'name')
      ));
    }
    while ((match = serviceRegex.exec(content)) !== null) {
      const attrs = match[1];
      consumers.push(this.consumer(
        relativePath,
        fullPath,
        content,
        match.index,
        'jax-ws',
        undefined,
        this.annotationValue(attrs, 'wsdlLocation'),
        '@WebService',
        this.annotationValue(attrs, 'serviceName') || this.annotationValue(attrs, 'name')
      ));
    }
    return consumers;
  }

  private extractCSharpConsumers(relativePath: string, fullPath: string, content: string): SoapConsumer[] {
    const consumers: SoapConsumer[] = [];
    const endpointRegex = /(?:EndpointAddress|Address\s*=\s*)\s*\(?\s*["']([^"']+)["']/g;
    const operationRegex = /\[OperationContract[^\]]*\]\s*(?:public\s+)?(?:async\s+)?(?:[A-Za-z0-9_<>,\[\]\s]+\s+)([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = endpointRegex.exec(content)) !== null) {
      consumers.push(this.consumer(relativePath, fullPath, content, match.index, 'System.ServiceModel', undefined, match[1], 'EndpointAddress'));
    }
    while ((match = operationRegex.exec(content)) !== null) {
      consumers.push(this.consumer(relativePath, fullPath, content, match.index, 'System.ServiceModel', match[1], undefined, '[OperationContract]'));
    }
    return consumers;
  }

  private extractRubyConsumers(relativePath: string, fullPath: string, content: string): SoapConsumer[] {
    const consumers: SoapConsumer[] = [];
    const wsdlRegex = /Savon\.client\s*\([^)]*wsdl:\s*['"]([^'"]+)['"]/g;
    const operationRegex = /\bclient\.call\s*\(\s*:([A-Za-z_][A-Za-z0-9_]*)/g;
    let match: RegExpExecArray | null;
    while ((match = wsdlRegex.exec(content)) !== null) {
      consumers.push(this.consumer(relativePath, fullPath, content, match.index, 'savon', undefined, match[1], 'Savon.client'));
    }
    while ((match = operationRegex.exec(content)) !== null) {
      consumers.push(this.consumer(relativePath, fullPath, content, match.index, 'savon', match[1], undefined, 'client.call'));
    }
    return consumers;
  }

  private consumer(
    relativePath: string,
    fullPath: string,
    content: string,
    index: number,
    library: string,
    operation: string | undefined,
    endpoint: string | undefined,
    evidence: string,
    service?: string
  ): SoapConsumer {
    return {
      relativePath,
      fullPath,
      line: content.slice(0, index).split('\n').length,
      library,
      operation,
      service,
      endpoint,
      evidence,
    };
  }

  private emitConsumerExitPoint(consumer: SoapConsumer, exitPoints: CASExitPoint[]): void {
    const sourceId = this.consumerSourceId(consumer.relativePath, consumer.line, consumer.operation || consumer.endpoint || consumer.library);
    exitPoints.push(this.createExitPoint(
      `exit_${sourceId}`,
      sourceId,
      'api',
      consumer.operation ? `SOAP call ${consumer.operation}` : `SOAP client ${consumer.library}`,
      consumer.operation ? `Outbound SOAP operation call through ${consumer.library}` : `Outbound SOAP client configured through ${consumer.library}`,
      {
        service_id: consumer.service || 'soap_service',
        endpoint: consumer.operation || consumer.endpoint,
        sdk: consumer.library,
      },
      {
        action: consumer.operation ? 'call' : 'connect',
        method: 'POST',
        async: false,
      },
      {
        protocol: 'soap',
        library: consumer.library,
        operation: consumer.operation,
        service: consumer.service,
        endpoint: consumer.endpoint,
        evidence: consumer.evidence,
        file: consumer.relativePath,
        line: consumer.line,
      }
    ));
  }

  private annotationValue(content: string, key: string): string | undefined {
    return content.match(new RegExp(`${key}\\s*=\\s*["']([^"']+)["']`))?.[1];
  }

  private first(value: any): any {
    return Array.isArray(value) ? value[0] : value;
  }

  private toArray<T>(value: T | T[] | undefined): T[] {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
  }

  private stringAttr(value: any): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private localName(value: string | undefined): string | undefined {
    if (!value) return undefined;
    return value.includes(':') ? value.split(':').pop() : value;
  }

  private soapProtocol(binding: any): 'soap11' | 'soap12' | undefined {
    const transport = this.stringAttr(binding?.transport) || '';
    if (transport.includes('soap12')) return 'soap12';
    if (transport.includes('soap')) return 'soap11';
    return undefined;
  }

  private fileId(relativePath: string): string {
    return `file_${this.sanitizeId(relativePath)}`;
  }

  private serviceId(relativePath: string, name: string): string {
    return `soap_service_${this.sanitizeId(relativePath)}_${this.sanitizeId(name)}`;
  }

  private operationId(relativePath: string, service: string, port: string, operation: string): string {
    return `soap_operation_${this.sanitizeId(relativePath)}_${this.sanitizeId(service)}_${this.sanitizeId(port)}_${this.sanitizeId(operation)}`;
  }

  private messageId(relativePath: string, name: string): string {
    return `soap_message_${this.sanitizeId(relativePath)}_${this.sanitizeId(name)}`;
  }

  private xsdTypeId(relativePath: string, kind: string, name: string): string {
    return `xsd_${this.sanitizeId(relativePath)}_${kind}_${this.sanitizeId(name)}`;
  }

  private consumerSourceId(relativePath: string, line: number, name: string): string {
    return `soap_consumer_${this.sanitizeId(relativePath)}_${line}_${this.sanitizeId(name)}`;
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
      'soap-services',
      'soap-operations',
      'wsdl-contracts',
      'xsd-types',
      'soap-consumers',
    ];
  }
}
