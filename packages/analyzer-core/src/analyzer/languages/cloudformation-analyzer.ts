import { AnalysisContext, BaseAnalyzer, FileAnalysisContext, FileAnalysisResult } from '../core/base-analyzer';
import { CASEdge, CASEntryPoint, CASExitPoint, CASNode } from '../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';
import * as yaml from 'js-yaml';

interface CloudFormationResource {
  logicalId: string;
  type: string;
  properties: Record<string, any>;
  dependsOn: string[];
  line: number;
}

export class CloudFormationAnalyzer extends BaseAnalyzer {
  constructor() {
    super('cloudformation', 'CloudFormation Analyzer', '1.0.0', 'language');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    return (await this.getRelevantFiles(projectPath)).length > 0;
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await glob(['**/*.{yaml,yml,json}', '**/*.template'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
      absolute: false,
    });
    const matches: string[] = [];
    for (const relativeFile of files) {
      const content = await this.safeRead(projectPath, relativeFile);
      if (!content || !this.isCloudFormationTemplate(content)) continue;
      matches.push(relativeFile);
    }
    return matches.sort();
  }

  async analyze(context: AnalysisContext) {
    const files = await this.getRelevantFiles(context.projectPath);
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    for (const relativeFile of files) {
      const parsed = await this.analyzeTemplate(context.projectPath, relativeFile);
      nodes.push(...parsed.nodes);
      edges.push(...parsed.edges);
      entryPoints.push(...parsed.entryPoints);
      exitPoints.push(...parsed.exitPoints);
    }

    return this.createContribution(nodes, edges, entryPoints, exitPoints, {
      topology_surface: 'cloudformation',
      cloudformation_templates: files.length,
    });
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const parsed = await this.analyzeTemplate(context.projectPath, context.relativePath);
    const content = await fs.readFile(context.filePath, 'utf8');
    const stat = await fs.stat(context.filePath);
    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      parsed.nodes,
      parsed.edges,
      parsed.entryPoints,
      parsed.exitPoints,
      [],
      parsed.nodes.map(node => node.qualified_name || node.name)
    );
  }

  protected getCapabilities(): string[] {
    return ['cloudformation-resource-inventory', 'cloudformation-ref-getatt-dependency-edges', 'aws-resource-join-key-extraction'];
  }

  protected getLevelName(level: number): string {
    if (level === 1) return 'cloudformation template';
    return 'cloudformation resource';
  }

  private async safeRead(projectPath: string, relativeFile: string): Promise<string | undefined> {
    try {
      return await fs.readFile(path.join(projectPath, relativeFile), 'utf8');
    } catch {
      return undefined;
    }
  }

  private isCloudFormationTemplate(content: string): boolean {
    const template = this.parseTemplate(content);
    if (!isRecord(template)) return false;
    if (typeof template.AWSTemplateFormatVersion === 'string') return true;
    const resources = isRecord(template.Resources) ? template.Resources : {};
    return Object.values(resources).some(resource => isRecord(resource) && typeof resource.Type === 'string' && resource.Type.startsWith('AWS::'));
  }

  private async analyzeTemplate(projectPath: string, relativeFile: string) {
    const content = await fs.readFile(path.join(projectPath, relativeFile), 'utf8');
    const template = this.parseTemplate(content);
    if (!isRecord(template) || !this.isCloudFormationTemplate(content)) {
      return { nodes: [], edges: [], entryPoints: [], exitPoints: [] };
    }

    const resources = this.extractResources(template, content);
    const templateId = `cloudformation_template_${this.sanitizeId(relativeFile)}`;
    const templateNode = this.createNode(templateId, `CloudFormation template: ${relativeFile}`, 'cloudformation_template', 1, relativeFile, 1, content.split(/\r?\n/).length, {
      topology_surface: 'cloudformation',
      template_format_version: stringValue(template.AWSTemplateFormatVersion),
      resource_count: resources.length,
      subcategories: ['infrastructure', 'cloudformation'],
    });

    const nodes: CASNode[] = [templateNode];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [this.createEntryPoint(
      `entry_cloudformation_${this.sanitizeId(relativeFile)}`,
      templateId,
      'file',
      `CloudFormation template ${relativeFile}`,
      'CloudFormation deploys this template as infrastructure configuration.',
      undefined,
      undefined,
      { topology_surface: 'cloudformation' },
      { node_id: templateId, method_name: 'cloudformation deploy', file: relativeFile, line: 1 }
    )];
    const exitPoints: CASExitPoint[] = [];
    const nodeByLogicalId = new Map<string, string>();

    for (const resource of resources) {
      const nodeId = `cloudformation_${this.sanitizeId(relativeFile)}_${this.sanitizeId(resource.logicalId)}`;
      nodeByLogicalId.set(resource.logicalId, nodeId);
      const normalizedType = normalizeAwsResourceType(resource.type);
      const props = keyProperties(resource);
      nodes.push(this.createNode(nodeId, `${resource.type}: ${resource.logicalId}`, normalizedType, 3, relativeFile, resource.line, resource.line, {
        topology_surface: 'cloudformation',
        cloudformation_logical_id: resource.logicalId,
        cloudformation_type: resource.type,
        provider: 'aws',
        service: awsServiceName(resource.type),
        ...props,
        subcategories: ['infrastructure', 'cloudformation', awsServiceName(resource.type)],
      }));
      edges.push(this.createEdge(
        `edge_cloudformation_contains_${this.sanitizeId(relativeFile)}_${this.sanitizeId(resource.logicalId)}`,
        templateId,
        nodeId,
        'contains',
        'structure',
        { topology_surface: 'cloudformation' }
      ));
      exitPoints.push(this.createExitPoint(
        `exit_cloudformation_${this.sanitizeId(relativeFile)}_${this.sanitizeId(resource.logicalId)}`,
        nodeId,
        'api',
        `${resource.type} ${resource.logicalId}`,
        `CloudFormation provisions ${resource.type} resource ${resource.logicalId}.`,
        { service_id: awsServiceName(resource.type), resource: resource.type },
        { action: 'provision', async: true },
        { topology_surface: 'cloudformation', cloudformation_logical_id: resource.logicalId, cloudformation_type: resource.type }
      ));
    }

    for (const resource of resources) {
      const sourceId = nodeByLogicalId.get(resource.logicalId);
      if (!sourceId) continue;
      for (const dependency of this.extractDependencies(resource)) {
        const targetId = nodeByLogicalId.get(dependency);
        if (!targetId) continue;
        edges.push(this.createEdge(
          `edge_cloudformation_dep_${this.sanitizeId(relativeFile)}_${this.sanitizeId(resource.logicalId)}_${this.sanitizeId(dependency)}`,
          sourceId,
          targetId,
          'depends_on',
          'dependency',
          { topology_surface: 'cloudformation', dependency_kind: 'Ref/GetAtt/DependsOn' }
        ));
      }
    }

    return { nodes, edges, entryPoints, exitPoints };
  }

  private parseTemplate(content: string): unknown {
    try {
      return JSON.parse(content);
    } catch {
      try {
        return yaml.load(normalizeCloudFormationShortTags(content), { schema: yaml.JSON_SCHEMA });
      } catch {
        return undefined;
      }
    }
  }

  private extractResources(template: Record<string, any>, content: string): CloudFormationResource[] {
    if (!isRecord(template.Resources)) return [];
    const lines = content.split(/\r?\n/);
    return Object.entries(template.Resources)
      .filter((entry): entry is [string, Record<string, any>] => isRecord(entry[1]) && typeof entry[1].Type === 'string' && entry[1].Type.startsWith('AWS::'))
      .map(([logicalId, resource]) => ({
        logicalId,
        type: resource.Type,
        properties: isRecord(resource.Properties) ? resource.Properties : {},
        dependsOn: Array.isArray(resource.DependsOn) ? resource.DependsOn.map(String) : stringValue(resource.DependsOn) ? [String(resource.DependsOn)] : [],
        line: findResourceLine(lines, logicalId),
      }));
  }

  private extractDependencies(resource: CloudFormationResource): string[] {
    const dependencies = new Set(resource.dependsOn);
    const visit = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!isRecord(value)) return;
      const ref = stringValue(value.Ref);
      if (ref) dependencies.add(ref);
      const getAtt = (value as any)['Fn::GetAtt'];
      if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') dependencies.add(getAtt[0]);
      if (typeof getAtt === 'string') dependencies.add(getAtt.split('.')[0]);
      Object.values(value).forEach(visit);
    };
    visit(resource.properties);
    dependencies.delete(resource.logicalId);
    return Array.from(dependencies);
  }
}

function normalizeAwsResourceType(type: string): string {
  return type.toLowerCase().replace(/^aws::/, 'aws_').replace(/::/g, '_').replace(/[^a-z0-9_]+/g, '_');
}

function awsServiceName(type: string): string {
  return type.split('::')[1]?.toLowerCase() || 'aws';
}

function keyProperties(resource: CloudFormationResource): Record<string, any> {
  const props = resource.properties;
  return compactRecord({
    queue_name: props.QueueName,
    table_name: props.TableName,
    bucket_name: props.BucketName,
    function_name: props.FunctionName,
    db_instance_identifier: props.DBInstanceIdentifier,
    service_name: props.ServiceName,
    cluster: props.Cluster,
    image: props.ImageUri,
    runtime: props.Runtime,
    handler: props.Handler,
    ports: extractPorts(props),
    environment_keys: isRecord(props.Environment?.Variables) ? Object.keys(props.Environment.Variables) : [],
  });
}

function extractPorts(value: unknown): string[] {
  const ports = new Set<string>();
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!isRecord(item)) return;
    for (const key of ['ContainerPort', 'HostPort', 'FromPort', 'ToPort', 'Port']) {
      const port = stringValue(item[key]);
      if (port) ports.add(port);
    }
    Object.values(item).forEach(visit);
  };
  visit(value);
  return Array.from(ports);
}

function normalizeCloudFormationShortTags(content: string): string {
  return content.split(/\r?\n/).map(line => {
    const keyRef = line.match(/^(\s*)([^:\n]+:\s*)!Ref\s+([A-Za-z0-9_.-]+)\s*$/);
    if (keyRef) return `${keyRef[1]}${keyRef[2]}\n${keyRef[1]}  Ref: ${keyRef[3]}`;
    const listRef = line.match(/^(\s*)-\s*!Ref\s+([A-Za-z0-9_.-]+)\s*$/);
    if (listRef) return `${listRef[1]}-\n${listRef[1]}  Ref: ${listRef[2]}`;
    const keyGetAtt = line.match(/^(\s*)([^:\n]+:\s*)!GetAtt\s+([A-Za-z0-9_.-]+)\.([A-Za-z0-9_.-]+)\s*$/);
    if (keyGetAtt) return `${keyGetAtt[1]}${keyGetAtt[2]}\n${keyGetAtt[1]}  Fn::GetAtt: [${keyGetAtt[3]}, ${keyGetAtt[4]}]`;
    const listGetAtt = line.match(/^(\s*)-\s*!GetAtt\s+([A-Za-z0-9_.-]+)\.([A-Za-z0-9_.-]+)\s*$/);
    if (listGetAtt) return `${listGetAtt[1]}-\n${listGetAtt[1]}  Fn::GetAtt: [${listGetAtt[2]}, ${listGetAtt[3]}]`;
    return line;
  }).join('\n');
}

function compactRecord(value: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item) && item.length === 0) continue;
    if (item === undefined || item === null || item === '') continue;
    out[key] = item;
  }
  return out;
}

function findResourceLine(lines: string[], logicalId: string): number {
  const pattern = new RegExp(`^\\s*${escapeRegExp(logicalId)}:\\s*$`);
  const index = lines.findIndex(line => pattern.test(line));
  return index === -1 ? 1 : index + 1;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
