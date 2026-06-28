import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import {
  CASContribution,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASNode,
  FileAnalysisResult,
  generateEdgeId,
  generateNodeId,
} from '../../types/cas.types';
import * as fs from 'fs-extra';
import * as crypto from 'crypto';

interface TerraformBlock {
  kind: string;
  type?: string;
  name?: string;
  line: number;
  endLine: number;
  body: string;
}

const TERRAFORM_IGNORED_DIRS = new Set([
  '.git',
  '.terraform',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'vendor',
  '.venv',
  '__pycache__',
]);

export class TerraformAnalyzer extends BaseAnalyzer {
  constructor() {
    super('terraform', 'Terraform/HCL Analyzer', '1.0.0', 'language');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const files = await this.getRelevantFiles(projectPath);
    return files.length > 0;
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files: string[] = [];
    this.collectTerraformFiles(projectPath, projectPath, files);
    return files.sort();
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const files = await this.getRelevantFiles(context.projectPath);
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    for (const relativePath of files) {
      const result = await this.analyzeTerraformFile(context.projectPath, relativePath);
      nodes.push(...result.nodes);
      edges.push(...result.edges);
      entryPoints.push(...result.entry_points);
      exitPoints.push(...result.exit_points);
    }

    return this.createContribution(nodes, edges, entryPoints, exitPoints, {
      categories: ['infrastructure', 'configuration', 'deployment'],
      infrastructure_files: files.length,
    });
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const result = await this.analyzeTerraformFile(context.projectPath, context.relativePath);
    const absolutePath = `${context.projectPath}/${context.relativePath}`;
    const stat = fs.statSync(absolutePath);
    const content = context.relativePath.endsWith('.tfplan')
      ? fs.readFileSync(absolutePath)
      : fs.readFileSync(absolutePath, 'utf8');
    return {
      filePath: context.relativePath,
      contentHash: context.contentHash || crypto.createHash('sha256').update(content).digest('hex'),
      mtimeMs: stat.mtimeMs,
      nodes: result.nodes,
      edges: result.edges,
      entryPoints: result.entry_points,
      exitPoints: result.exit_points,
      imports: [],
      exports: result.nodes
        .filter(node => node.type !== 'infrastructure_file')
        .map(node => node.qualified_name || node.name),
    };
  }

  protected getCapabilities(): string[] {
    return [
      'Terraform module/resource inventory',
      'Cloud/provider boundary detection',
      'Infrastructure configuration graph',
      'Variable/output surface detection',
    ];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'infrastructure file';
      case 2: return 'provider/configuration';
      case 3: return 'module';
      case 4: return 'resource/data source';
      case 5: return 'variable/output';
      default: return `level_${level}`;
    }
  }

  private async analyzeTerraformFile(projectPath: string, relativePath: string) {
    const absolutePath = `${projectPath}/${relativePath}`;
    if (relativePath.endsWith('.tfplan')) {
      return this.analyzeTerraformPlanArtifact(projectPath, relativePath);
    }
    const content = fs.readFileSync(absolutePath, 'utf8');
    const blocks = this.extractBlocks(content);
    const fileId = generateNodeId('terraform_file', relativePath, relativePath);
    const environment = this.inferEnvironment(relativePath);
    const fileNode: CASNode = {
      id: fileId,
      name: relativePath.split('/').pop() || relativePath,
      qualified_name: relativePath,
      type: 'infrastructure_file',
      category: 'infrastructure',
      level: 1,
      analyzers: [this.id],
      primaryAnalyzer: this.id,
      description: `Terraform/HCL file ${relativePath}`,
      source: { file: relativePath, line: 1, end_line: content.split('\n').length },
      metadata: {
        language: 'Terraform/HCL',
        paradigm: 'declarative-infrastructure',
        topology_surface: 'terraform',
        environment,
        attributes: {
          block_count: blocks.length,
          providers: this.extractProviderNames(blocks),
          environment,
        },
      } as any,
      configuration: {
        config_files: [relativePath],
        environment_variables: [],
        required_services: this.extractProviderNames(blocks),
      },
    };

    const nodes: CASNode[] = [fileNode];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [{
      id: generateNodeId('entry', relativePath, 'terraform'),
      source_node: fileId,
      source_analyzer: this.id,
      type: 'file',
      name: `Terraform file ${relativePath}`,
      description: 'Terraform plan/apply reads this file as infrastructure configuration.',
      handler: { node_id: fileId, method_name: 'terraform plan/apply', file: relativePath, line: 1 },
      connected_nodes: [fileId],
      metadata: { language: 'Terraform/HCL' },
    }];
    const exitPoints: CASExitPoint[] = [];

    for (const block of blocks) {
      const node = this.nodeFromBlock(relativePath, block);
      nodes.push(node);
      edges.push({
        id: generateEdgeId(fileId, node.id, 'contains'),
        source: fileId,
        target: node.id,
        type: 'contains',
        category: 'structure',
        metadata: { confidence: 0.95, locations: [{ file: relativePath, line: block.line }] },
      });

      if (block.kind === 'resource' || block.kind === 'data') {
        exitPoints.push(this.exitPointForBlock(node, relativePath, block));
      }

      for (const dependency of this.extractDependsOn(block.body)) {
        const targetId = generateNodeId('terraform_ref', relativePath, dependency);
        const existingTarget = nodes.find(candidate => candidate.metadata?.attributes?.terraform_address === dependency);
        if (!existingTarget && !nodes.some(candidate => candidate.id === targetId)) {
          nodes.push({
            id: targetId,
            name: dependency,
            qualified_name: dependency,
            type: 'infrastructure_reference',
            category: 'infrastructure',
            level: 4,
            analyzers: [this.id],
            primaryAnalyzer: this.id,
            description: `Terraform reference to ${dependency}. The referenced block was not resolved inside ${relativePath}.`,
            source: { file: relativePath, line: block.line, end_line: block.endLine },
            metadata: {
              language: 'Terraform/HCL',
              paradigm: 'declarative-infrastructure',
              attributes: {
                terraform_address: dependency,
                unresolved_reference: true,
              },
            },
          });
        }
        edges.push({
          id: generateEdgeId(node.id, existingTarget?.id || targetId, 'depends_on'),
          source: node.id,
          target: existingTarget?.id || targetId,
          type: 'depends_on',
          category: 'dependency',
          metadata: { confidence: existingTarget ? 0.9 : 0.65, locations: [{ file: relativePath, line: block.line }] },
        });
      }
    }

    return { nodes, edges, entry_points: entryPoints, exit_points: exitPoints };
  }

  private collectTerraformFiles(projectPath: string, currentPath: string, files: string[]): void {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (TERRAFORM_IGNORED_DIRS.has(entry.name)) continue;
        this.collectTerraformFiles(projectPath, `${currentPath}/${entry.name}`, files);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.tf') && !entry.name.endsWith('.tfvars') && !entry.name.endsWith('.tfplan') && !this.isTerraformBackendConfig(projectPath, currentPath, entry.name)) continue;
      files.push(pathRelative(projectPath, `${currentPath}/${entry.name}`));
    }
  }

  private isTerraformBackendConfig(projectPath: string, currentPath: string, fileName: string): boolean {
    if (!fileName.endsWith('.conf')) return false;
    const relativeDir = pathRelative(projectPath, currentPath).toLowerCase();
    return relativeDir === 'environments' || relativeDir.includes('/environments') || fileName.toLowerCase().includes('backend');
  }

  private analyzeTerraformPlanArtifact(projectPath: string, relativePath: string) {
    const absolutePath = `${projectPath}/${relativePath}`;
    const stat = fs.statSync(absolutePath);
    const environment = this.inferEnvironment(relativePath);
    const nodeId = generateNodeId('terraform_plan', relativePath, relativePath);
    const node: CASNode = {
      id: nodeId,
      name: relativePath.split('/').pop() || relativePath,
      qualified_name: relativePath,
      type: 'infrastructure_plan',
      category: 'infrastructure',
      level: 1,
      analyzers: [this.id],
      primaryAnalyzer: this.id,
      description: `Terraform plan artifact ${relativePath}`,
      source: { file: relativePath, line: 1, end_line: 1 },
      metadata: {
        language: 'Terraform plan',
        paradigm: 'declarative-infrastructure',
        topology_surface: 'terraform',
        environment,
        attributes: {
          artifact_kind: 'terraform-plan',
          binary: true,
          bytes: stat.size,
          environment,
        },
      } as any,
      configuration: {
        config_files: [relativePath],
        environment_variables: [],
        required_services: ['terraform'],
      },
    };
    const entryPoint: CASEntryPoint = {
      id: generateNodeId('entry', relativePath, 'terraform-plan'),
      source_node: nodeId,
      source_analyzer: this.id,
      type: 'file',
      name: `Terraform plan ${relativePath}`,
      description: 'Terraform can apply this saved plan artifact for an environment-specific deployment.',
      handler: { node_id: nodeId, method_name: 'terraform apply', file: relativePath, line: 1 },
      connected_nodes: [nodeId],
      metadata: { language: 'Terraform plan', environment },
    };
    return { nodes: [node], edges: [], entry_points: [entryPoint], exit_points: [] };
  }

  private nodeFromBlock(relativePath: string, block: TerraformBlock): CASNode {
    const address = this.blockAddress(block);
    return {
      id: generateNodeId('terraform', relativePath, `${address}:${block.line}`),
      name: address,
      qualified_name: address,
      type: this.nodeType(block),
      category: 'infrastructure',
      level: this.nodeLevel(block),
      analyzers: [this.id],
      primaryAnalyzer: this.id,
      description: this.describeBlock(block),
      source: { file: relativePath, line: block.line, end_line: block.endLine },
      metadata: {
        language: 'Terraform/HCL',
        paradigm: 'declarative-infrastructure',
        topology_surface: 'terraform',
        environment: this.inferEnvironment(relativePath),
        attributes: {
          block_kind: block.kind,
          terraform_type: block.type,
          terraform_name: block.name,
          terraform_address: address,
          provider: this.providerForBlock(block),
          depends_on: this.extractDependsOn(block.body),
          environment: this.inferEnvironment(relativePath),
        },
      } as any,
      configuration: {
        config_files: [relativePath],
        required_services: this.providerForBlock(block) ? [this.providerForBlock(block)!] : [],
      },
    };
  }

  private exitPointForBlock(node: CASNode, relativePath: string, block: TerraformBlock): CASExitPoint {
    const provider = this.providerForBlock(block) || 'infrastructure-provider';
    return {
      id: generateNodeId('exit', relativePath, `${node.id}:${provider}`),
      source_node: node.id,
      source_analyzer: this.id,
      type: 'sdk',
      name: `${provider} ${block.kind}`,
      description: `${node.name} provisions or reads ${provider} infrastructure.`,
      target: {
        service_id: provider,
        resource: block.type,
        sdk: 'Terraform provider',
      },
      operation: {
        action: block.kind === 'data' ? 'read' : 'provision',
        async: false,
      },
      connected_nodes: [node.id],
      metadata: { file: relativePath, provider, terraform_type: block.type },
    };
  }

  private inferEnvironment(relativePath: string): string | undefined {
    const normalized = relativePath.toLowerCase();
    if (/(^|\/)(prod|production)(\/|\.|-|_)/.test(normalized)) return 'production';
    if (/(^|\/)(stage|staging)(\/|\.|-|_)/.test(normalized)) return 'staging';
    if (/(^|\/)(dev|development)(\/|\.|-|_)/.test(normalized)) return 'development';
    if (/(^|\/)(demo)(\/|\.|-|_)/.test(normalized)) return 'demo';
    if (/(^|\/)(internal)(\/|\.|-|_)/.test(normalized)) return 'internal';
    if (/(^|\/)(local)(\/|\.|-|_)/.test(normalized)) return 'local';
    return undefined;
  }

  private extractBlocks(content: string): TerraformBlock[] {
    const lines = content.split('\n');
    const blocks: TerraformBlock[] = [];
    const blockPattern = /^\s*(resource|data|module|variable|output|provider|terraform|locals)\s*(?:"([^"]+)")?\s*(?:"([^"]+)")?\s*\{/;

    for (let index = 0; index < lines.length; index++) {
      const match = blockPattern.exec(lines[index]);
      if (!match) continue;
      let depth = 0;
      let end = index;
      for (; end < lines.length; end++) {
        depth += countChar(lines[end], '{');
        depth -= countChar(lines[end], '}');
        if (depth <= 0 && end > index) break;
      }
      blocks.push({
        kind: match[1],
        type: match[2],
        name: match[3],
        line: index + 1,
        endLine: Math.min(lines.length, end + 1),
        body: lines.slice(index, end + 1).join('\n'),
      });
      index = end;
    }

    return blocks;
  }

  private extractProviderNames(blocks: TerraformBlock[]): string[] {
    return Array.from(new Set(blocks
      .map(block => this.providerForBlock(block))
      .filter((value): value is string => Boolean(value))));
  }

  private providerForBlock(block: TerraformBlock): string | undefined {
    if (block.kind === 'provider') return block.type;
    if (!block.type) return undefined;
    const match = /^([a-z0-9]+)_/i.exec(block.type);
    return match?.[1];
  }

  private extractDependsOn(body: string): string[] {
    const dependencies = new Set<string>();
    const dependsMatch = /depends_on\s*=\s*\[([^\]]+)\]/m.exec(body);
    if (dependsMatch) {
      for (const match of dependsMatch[1].match(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || []) {
        dependencies.add(match);
      }
    }
    for (const match of body.match(/\b(?:aws|azurerm|google|module|data)\.[A-Za-z0-9_.-]+/g) || []) {
      dependencies.add(match);
    }
    return Array.from(dependencies).slice(0, 20);
  }

  private blockAddress(block: TerraformBlock): string {
    if (block.kind === 'resource' || block.kind === 'data') return `${block.kind}.${block.type}.${block.name}`;
    if (block.name) return `${block.kind}.${block.name}`;
    if (block.type) return `${block.kind}.${block.type}`;
    return block.kind;
  }

  private nodeType(block: TerraformBlock): string {
    if (block.kind === 'resource') return 'infrastructure_resource';
    if (block.kind === 'data') return 'infrastructure_data_source';
    if (block.kind === 'module') return 'infrastructure_module';
    if (block.kind === 'variable') return 'configuration_variable';
    if (block.kind === 'output') return 'configuration_output';
    if (block.kind === 'provider') return 'infrastructure_provider';
    return 'infrastructure_configuration';
  }

  private nodeLevel(block: TerraformBlock): number {
    if (block.kind === 'provider' || block.kind === 'terraform') return 2;
    if (block.kind === 'module') return 3;
    if (block.kind === 'resource' || block.kind === 'data') return 4;
    return 5;
  }

  private describeBlock(block: TerraformBlock): string {
    const provider = this.providerForBlock(block);
    if (block.kind === 'resource') return `Terraform resource ${block.type}.${block.name}${provider ? ` managed through the ${provider} provider` : ''}.`;
    if (block.kind === 'data') return `Terraform data source ${block.type}.${block.name}${provider ? ` read through the ${provider} provider` : ''}.`;
    if (block.kind === 'module') return `Terraform module ${block.name}.`;
    if (block.kind === 'variable') return `Terraform input variable ${block.type}.`;
    if (block.kind === 'output') return `Terraform output ${block.type}.`;
    if (block.kind === 'provider') return `Terraform provider ${block.type}.`;
    return `Terraform ${block.kind} block.`;
  }
}

function countChar(value: string, char: string): number {
  return value.split(char).length - 1;
}

function pathRelative(root: string, absolutePath: string): string {
  return absolutePath.slice(root.length).replace(/^\/+/, '');
}
