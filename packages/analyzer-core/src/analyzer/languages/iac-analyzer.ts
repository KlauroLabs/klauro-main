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
import * as path from 'path';
import { cachedGlob as glob } from '../core/glob-cache';

// Shared helpers for the IaC (Ansible/Pulumi/Helm) analyzers. Terraform and
// Kubernetes/Docker manifests already have dedicated analyzers
// (terraform-analyzer.ts, container-topology-analyzer.ts) — this file covers
// the remaining IaC surfaces named in the mission: Ansible playbooks/roles,
// Pulumi programs (TS/Python/Go resource declarations), and Helm charts
// (chart metadata + templates + values, layered on top of the Kubernetes
// manifest shapes already understood by KubernetesManifestAnalyzer).

abstract class IacAnalyzer extends BaseAnalyzer {
  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  protected async readFiles(projectPath: string, patterns: string[]): Promise<string[]> {
    return glob(patterns, {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
      absolute: false,
    });
  }

  protected getIgnorePatterns(_context: { projectPath: string }): string[] {
    return [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/vendor/**',
      '**/.venv/**',
      '**/__pycache__/**',
    ];
  }

  protected computeContentHash(content: string): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  protected async fileResult(
    context: FileAnalysisContext,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
  ): Promise<FileAnalysisResult> {
    const absolutePath = context.filePath;
    const content = await fs.readFile(absolutePath, 'utf8');
    const stat = await fs.stat(absolutePath);
    return {
      filePath: context.relativePath,
      contentHash: context.contentHash || this.computeContentHash(content),
      mtimeMs: stat.mtimeMs,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      imports: [],
      exports: nodes.map(node => node.qualified_name || node.name),
    };
  }

  protected sanitizeId(value: string): string {
    return (value || 'unknown').toLowerCase().replace(/[^a-z0-9_.-]+/g, '_');
  }
}

// ---------------------------------------------------------------------------
// Ansible: playbooks (list of plays with hosts/roles/tasks) and role
// directories (roles/<name>/tasks/main.yml, handlers/main.yml). Tasks become
// nodes under their play/role; role inclusion becomes a dependency edge.
// ---------------------------------------------------------------------------

interface AnsibleTask {
  name: string;
  module: string;
  line: number;
}

interface AnsiblePlay {
  name: string;
  hosts?: string;
  roles: string[];
  line: number;
}

export class AnsibleAnalyzer extends IacAnalyzer {
  constructor() {
    super('ansible', 'Ansible Analyzer', '1.0.0', 'language');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    return (await this.getRelevantFiles(projectPath)).length > 0;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const [playbooks, roleTasks, roleHandlers, cfg] = await Promise.all([
      this.readFiles(projectPath, ['**/playbook*.yml', '**/playbook*.yaml', '**/site.yml', '**/site.yaml']),
      this.readFiles(projectPath, ['**/roles/*/tasks/*.yml', '**/roles/*/tasks/*.yaml']),
      this.readFiles(projectPath, ['**/roles/*/handlers/*.yml', '**/roles/*/handlers/*.yaml']),
      this.readFiles(projectPath, ['**/ansible.cfg']),
    ]);
    const candidates = new Set([...playbooks, ...roleTasks, ...roleHandlers]);
    if (cfg.length > 0) {
      const inventoryPlaybooks = await this.readFiles(projectPath, ['**/*.yml', '**/*.yaml']);
      for (const file of inventoryPlaybooks) {
        if (candidates.has(file)) continue;
        const content = await this.safeRead(projectPath, file);
        if (content && this.looksLikePlaybook(content)) candidates.add(file);
      }
    }
    return Array.from(candidates).sort();
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const files = await this.getRelevantFiles(context.projectPath);
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    for (const relativePath of files) {
      const result = await this.analyzeAnsibleFile(context.projectPath, relativePath);
      nodes.push(...result.nodes);
      edges.push(...result.edges);
      entryPoints.push(...result.entryPoints);
      exitPoints.push(...result.exitPoints);
    }
    return this.createContribution(nodes, edges, entryPoints, exitPoints, {
      categories: ['infrastructure', 'configuration', 'automation'],
      infrastructure_files: files.length,
    });
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const result = await this.analyzeAnsibleFile(context.projectPath, context.relativePath);
    return this.fileResult(context, result.nodes, result.edges, result.entryPoints, result.exitPoints);
  }

  protected getCapabilities(): string[] {
    return ['ansible-playbook-inventory', 'ansible-role-task-graph', 'ansible-handler-notification-edges'];
  }

  protected getLevelName(level: number): string {
    if (level === 1) return 'ansible file';
    if (level === 2) return 'play';
    if (level === 3) return 'role';
    return 'task/handler';
  }

  private async safeRead(projectPath: string, relativePath: string): Promise<string | undefined> {
    try {
      return await fs.readFile(path.join(projectPath, relativePath), 'utf8');
    } catch {
      return undefined;
    }
  }

  private looksLikePlaybook(content: string): boolean {
    return /^\s*-\s*hosts:\s*/m.test(content) || /^\s*-\s*name:\s*.+\n\s*hosts:/m.test(content);
  }

  private isRoleTaskFile(relativePath: string): boolean {
    return /roles\/[^/]+\/(tasks|handlers)\//.test(relativePath.replace(/\\/g, '/'));
  }

  private async analyzeAnsibleFile(projectPath: string, relativePath: string) {
    const content = await this.safeRead(projectPath, relativePath) || '';
    const fileId = generateNodeId('ansible_file', relativePath, relativePath);
    const isRoleFile = this.isRoleTaskFile(relativePath);
    const isHandlers = /\/handlers\//.test(relativePath.replace(/\\/g, '/'));
    const roleName = isRoleFile ? this.extractRoleName(relativePath) : undefined;

    const fileNode: CASNode = {
      id: fileId,
      name: relativePath.split('/').pop() || relativePath,
      qualified_name: relativePath,
      type: isRoleFile ? 'ansible_role_file' : 'ansible_playbook_file',
      category: 'infrastructure',
      level: 1,
      analyzers: [this.id],
      primaryAnalyzer: this.id,
      description: isRoleFile
        ? `Ansible ${isHandlers ? 'handlers' : 'tasks'} for role ${roleName}.`
        : `Ansible playbook ${relativePath}.`,
      source: { file: relativePath, line: 1, end_line: content.split('\n').length },
      metadata: {
        language: 'Ansible/YAML',
        paradigm: 'declarative-infrastructure',
        attributes: {
          topology_surface: 'ansible',
          role_name: roleName,
        },
      } as any,
      configuration: { config_files: [relativePath] },
    };

    const nodes: CASNode[] = [fileNode];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    if (!isRoleFile) {
      const plays = this.extractPlays(content);
      for (const play of plays) {
        const playId = generateNodeId('ansible_play', relativePath, `${play.name}:${play.line}`);
        nodes.push({
          id: playId,
          name: play.name,
          qualified_name: `${relativePath}#${play.name}`,
          type: 'ansible_play',
          category: 'infrastructure',
          level: 2,
          analyzers: [this.id],
          primaryAnalyzer: this.id,
          description: `Ansible play "${play.name}" targeting hosts: ${play.hosts || 'unspecified'}.`,
          source: { file: relativePath, line: play.line, end_line: play.line },
          metadata: {
            language: 'Ansible/YAML',
            paradigm: 'declarative-infrastructure',
            attributes: { topology_surface: 'ansible', hosts: play.hosts, roles: play.roles },
          } as any,
        });
        edges.push({
          id: generateEdgeId(fileId, playId, 'contains'),
          source: fileId,
          target: playId,
          type: 'contains',
          category: 'structure',
          metadata: { confidence: 0.95, locations: [{ file: relativePath, line: play.line }] },
        });
        entryPoints.push({
          id: generateNodeId('entry', relativePath, `ansible-play:${play.name}`),
          source_node: playId,
          source_analyzer: this.id,
          type: 'cli',
          name: `ansible-playbook ${relativePath} (${play.name})`,
          description: `Run via ansible-playbook against hosts: ${play.hosts || 'unspecified'}.`,
          handler: { node_id: playId, method_name: 'ansible-playbook', file: relativePath, line: play.line },
          connected_nodes: [playId],
          metadata: { language: 'Ansible/YAML', hosts: play.hosts },
        });
        for (const roleRef of play.roles) {
          const roleRefId = generateNodeId('ansible_role_ref', relativePath, roleRef);
          if (!nodes.some(n => n.id === roleRefId)) {
            nodes.push({
              id: roleRefId,
              name: roleRef,
              qualified_name: `role:${roleRef}`,
              type: 'ansible_role_reference',
              category: 'infrastructure',
              level: 3,
              analyzers: [this.id],
              primaryAnalyzer: this.id,
              description: `Ansible role ${roleRef} referenced by play "${play.name}".`,
              source: { file: relativePath, line: play.line, end_line: play.line },
              metadata: { language: 'Ansible/YAML', attributes: { topology_surface: 'ansible', role_name: roleRef } } as any,
            });
          }
          edges.push({
            id: generateEdgeId(playId, roleRefId, 'depends_on'),
            source: playId,
            target: roleRefId,
            type: 'depends_on',
            category: 'dependency',
            metadata: { confidence: 0.85, locations: [{ file: relativePath, line: play.line }] },
          });
        }
      }
    } else if (roleName) {
      const roleNodeId = generateNodeId('ansible_role', relativePath, roleName);
      nodes.push({
        id: roleNodeId,
        name: roleName,
        qualified_name: `role:${roleName}`,
        type: 'ansible_role',
        category: 'infrastructure',
        level: 3,
        analyzers: [this.id],
        primaryAnalyzer: this.id,
        description: `Ansible role ${roleName}.`,
        source: { file: relativePath, line: 1, end_line: content.split('\n').length },
        metadata: { language: 'Ansible/YAML', attributes: { topology_surface: 'ansible', role_name: roleName } } as any,
      });
      edges.push({
        id: generateEdgeId(fileId, roleNodeId, 'contains'),
        source: fileId,
        target: roleNodeId,
        type: 'contains',
        category: 'structure',
        metadata: { confidence: 0.9, locations: [{ file: relativePath, line: 1 }] },
      });

      const tasks = this.extractTasks(content);
      for (const task of tasks) {
        const taskId = generateNodeId('ansible_task', relativePath, `${task.name}:${task.line}`);
        nodes.push({
          id: taskId,
          name: task.name,
          qualified_name: `${relativePath}#${task.name}`,
          type: isHandlers ? 'ansible_handler' : 'ansible_task',
          category: 'infrastructure',
          level: 4,
          analyzers: [this.id],
          primaryAnalyzer: this.id,
          description: `Ansible ${isHandlers ? 'handler' : 'task'} "${task.name}" using module ${task.module}.`,
          source: { file: relativePath, line: task.line, end_line: task.line },
          metadata: {
            language: 'Ansible/YAML',
            attributes: { topology_surface: 'ansible', ansible_module: task.module, role_name: roleName },
          } as any,
        });
        edges.push({
          id: generateEdgeId(roleNodeId, taskId, 'contains'),
          source: roleNodeId,
          target: taskId,
          type: 'contains',
          category: 'structure',
          metadata: { confidence: 0.9, locations: [{ file: relativePath, line: task.line }] },
        });
        if (this.isProvisioningModule(task.module)) {
          exitPoints.push({
            id: generateNodeId('exit', relativePath, `${taskId}:${task.module}`),
            source_node: taskId,
            source_analyzer: this.id,
            type: 'sdk',
            name: `ansible ${task.module}`,
            description: `${task.name} provisions/configures a system resource via the ${task.module} module.`,
            target: { service_id: task.module, resource: task.module, sdk: 'Ansible module' },
            operation: { action: 'provision', async: false },
            connected_nodes: [taskId],
            metadata: { file: relativePath, ansible_module: task.module },
          });
        }
      }
    }

    return { nodes, edges, entryPoints, exitPoints };
  }

  private extractRoleName(relativePath: string): string | undefined {
    const match = /roles\/([^/]+)\/(tasks|handlers)\//.exec(relativePath.replace(/\\/g, '/'));
    return match?.[1];
  }

  private extractPlays(content: string): AnsiblePlay[] {
    const lines = content.split(/\r?\n/);
    const plays: AnsiblePlay[] = [];
    let current: AnsiblePlay | null = null;
    let inRoles = false;

    lines.forEach((line, index) => {
      const hostsAtDash = line.match(/^\s*-\s*hosts:\s*(.+)\s*$/);
      const nameAtDash = line.match(/^\s*-\s*name:\s*(.+)\s*$/);
      if (hostsAtDash) {
        if (current) plays.push(current);
        current = { name: `play_${plays.length + 1}`, hosts: cleanScalar(hostsAtDash[1]), roles: [], line: index + 1 };
        inRoles = false;
        return;
      }
      if (nameAtDash && !current) {
        current = { name: cleanScalar(nameAtDash[1]), hosts: undefined, roles: [], line: index + 1 };
        inRoles = false;
        return;
      }
      if (!current) return;
      const hostsMatch = line.match(/^\s{2,}hosts:\s*(.+)\s*$/);
      if (hostsMatch) { current.hosts = cleanScalar(hostsMatch[1]); return; }
      const nameMatch = line.match(/^\s{2,}name:\s*(.+)\s*$/);
      if (nameMatch && current.name.startsWith('play_')) { current.name = cleanScalar(nameMatch[1]); return; }
      if (/^\s{2,}roles:\s*$/.test(line)) { inRoles = true; return; }
      if (inRoles) {
        const roleItem = line.match(/^\s*-\s*(?:\{?\s*role:\s*)?["']?([A-Za-z0-9_.-]+)["']?/);
        if (roleItem && /^\s{4,}-/.test(line)) { current.roles.push(roleItem[1]); return; }
        if (/^\s{2,}[a-z_]+:/.test(line) && !/^\s{2,}-/.test(line)) inRoles = false;
      }
    });
    if (current) plays.push(current);
    return plays;
  }

  private extractTasks(content: string): AnsibleTask[] {
    const lines = content.split(/\r?\n/);
    const tasks: AnsibleTask[] = [];
    const knownModules = new Set([
      'apt', 'yum', 'dnf', 'package', 'service', 'systemd', 'copy', 'template', 'file',
      'command', 'shell', 'git', 'pip', 'user', 'group', 'lineinfile', 'docker_container',
      'docker_image', 'k8s', 'ec2', 'cloudformation', 'unarchive', 'get_url', 'cron',
      'firewalld', 'ufw', 'mount', 'reboot', 'debug', 'set_fact', 'include_tasks', 'import_tasks',
    ]);

    lines.forEach((line, index) => {
      const nameMatch = line.match(/^\s*-\s*name:\s*(.+)\s*$/);
      if (!nameMatch) return;
      let module: string | undefined;
      for (let cursor = index + 1; cursor < Math.min(lines.length, index + 15); cursor++) {
        if (/^\s*-\s*name:/.test(lines[cursor])) break;
        const moduleMatch = lines[cursor].match(/^\s{2,}([a-z0-9_]+):/);
        if (moduleMatch && (knownModules.has(moduleMatch[1]) || moduleMatch[1].includes('_'))) {
          module = moduleMatch[1];
          break;
        }
      }
      tasks.push({ name: cleanScalar(nameMatch[1]), module: module || 'unknown', line: index + 1 });
    });
    return tasks;
  }

  private isProvisioningModule(module: string): boolean {
    return !['debug', 'set_fact', 'include_tasks', 'import_tasks', 'unknown', 'meta'].includes(module);
  }
}

// ---------------------------------------------------------------------------
// Pulumi: programs declare resources via `new <Provider>.<Resource>(...)` in
// TS/JS, `<provider>.<Resource>(...)` in Python, or `<provider>.New<Resource>`
// in Go. Pulumi.yaml identifies the project/stack.
// ---------------------------------------------------------------------------

interface PulumiResourceDecl {
  variable: string;
  resourceType: string;
  logicalName?: string;
  line: number;
}

export class PulumiAnalyzer extends IacAnalyzer {
  constructor() {
    super('pulumi', 'Pulumi Analyzer', '1.0.0', 'language');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const projectFiles = await this.readFiles(projectPath, ['**/Pulumi.yaml', '**/Pulumi.yml']);
    return projectFiles.length > 0;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const projectFiles = await this.readFiles(projectPath, ['**/Pulumi.yaml', '**/Pulumi.yml', '**/Pulumi.*.yaml']);
    if (projectFiles.length === 0) return [];
    const programRoots = projectFiles.map(file => path.dirname(file));
    const programFiles = await this.readFiles(
      projectPath,
      programRoots.flatMap(root => [
        `${root}/**/*.ts`,
        `${root}/**/*.py`,
        `${root}/**/*.go`,
      ]).map(pattern => pattern.replace(/^\.\//, ''))
    );
    return Array.from(new Set([...projectFiles, ...programFiles])).sort();
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const files = await this.getRelevantFiles(context.projectPath);
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    for (const relativePath of files) {
      const result = await this.analyzePulumiFile(context.projectPath, relativePath);
      nodes.push(...result.nodes);
      edges.push(...result.edges);
      entryPoints.push(...result.entryPoints);
      exitPoints.push(...result.exitPoints);
    }
    return this.createContribution(nodes, edges, entryPoints, exitPoints, {
      categories: ['infrastructure', 'configuration', 'deployment'],
      infrastructure_files: files.length,
    });
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const result = await this.analyzePulumiFile(context.projectPath, context.relativePath);
    return this.fileResult(context, result.nodes, result.edges, result.entryPoints, result.exitPoints);
  }

  protected getCapabilities(): string[] {
    return ['pulumi-project-detection', 'pulumi-resource-inventory', 'pulumi-resource-reference-graph'];
  }

  protected getLevelName(level: number): string {
    if (level === 1) return 'pulumi file';
    if (level === 2) return 'pulumi project';
    return 'pulumi resource';
  }

  private async analyzePulumiFile(projectPath: string, relativePath: string) {
    const content = await fs.readFile(path.join(projectPath, relativePath), 'utf8');
    const fileId = generateNodeId('pulumi_file', relativePath, relativePath);
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    if (/Pulumi\.ya?ml$/.test(relativePath)) {
      const projectName = /^name:\s*(.+)\s*$/m.exec(content)?.[1]?.trim();
      const runtime = /^runtime:\s*(.+)\s*$/m.exec(content)?.[1]?.trim();
      const fileNode: CASNode = {
        id: fileId,
        name: projectName || relativePath,
        qualified_name: relativePath,
        type: 'pulumi_project',
        category: 'infrastructure',
        level: 2,
        analyzers: [this.id],
        primaryAnalyzer: this.id,
        description: `Pulumi project ${projectName || relativePath}${runtime ? ` (${runtime} runtime)` : ''}.`,
        source: { file: relativePath, line: 1, end_line: content.split('\n').length },
        metadata: {
          language: 'Pulumi',
          paradigm: 'declarative-infrastructure',
          attributes: { topology_surface: 'pulumi', pulumi_runtime: runtime },
        } as any,
        configuration: { config_files: [relativePath] },
      };
      nodes.push(fileNode);
      entryPoints.push({
        id: generateNodeId('entry', relativePath, 'pulumi'),
        source_node: fileId,
        source_analyzer: this.id,
        type: 'cli',
        name: `pulumi up (${projectName || relativePath})`,
        description: 'Pulumi CLI provisions this stack from the program.',
        handler: { node_id: fileId, method_name: 'pulumi up', file: relativePath, line: 1 },
        connected_nodes: [fileId],
        metadata: { language: 'Pulumi', runtime },
      });
      return { nodes, edges, entryPoints, exitPoints };
    }

    const language = relativePath.endsWith('.py') ? 'Python' : relativePath.endsWith('.go') ? 'Go' : 'TypeScript/JavaScript';
    const resources = this.extractResourceDeclarations(content, language);
    if (resources.length === 0) return { nodes: [], edges: [], entryPoints: [], exitPoints: [] };

    const programFileId = generateNodeId('pulumi_program_file', relativePath, relativePath);
    nodes.push({
      id: programFileId,
      name: relativePath.split('/').pop() || relativePath,
      qualified_name: relativePath,
      type: 'pulumi_program_file',
      category: 'infrastructure',
      level: 1,
      analyzers: [this.id],
      primaryAnalyzer: this.id,
      description: `Pulumi program file ${relativePath} (${language}).`,
      source: { file: relativePath, line: 1, end_line: content.split('\n').length },
      metadata: { language: `Pulumi/${language}`, attributes: { topology_surface: 'pulumi' } } as any,
    });

    for (const resource of resources) {
      const resourceId = generateNodeId('pulumi_resource', relativePath, `${resource.variable}:${resource.line}`);
      nodes.push({
        id: resourceId,
        name: resource.logicalName || resource.variable,
        qualified_name: `${relativePath}#${resource.variable}`,
        type: 'infrastructure_resource',
        category: 'infrastructure',
        level: 3,
        analyzers: [this.id],
        primaryAnalyzer: this.id,
        description: `Pulumi resource ${resource.resourceType} declared as ${resource.variable}.`,
        source: { file: relativePath, line: resource.line, end_line: resource.line },
        metadata: {
          language: `Pulumi/${language}`,
          paradigm: 'declarative-infrastructure',
          attributes: {
            topology_surface: 'pulumi',
            pulumi_resource_type: resource.resourceType,
            pulumi_variable: resource.variable,
            provider: this.providerFromResourceType(resource.resourceType),
          },
        } as any,
      });
      edges.push({
        id: generateEdgeId(programFileId, resourceId, 'contains'),
        source: programFileId,
        target: resourceId,
        type: 'contains',
        category: 'structure',
        metadata: { confidence: 0.9, locations: [{ file: relativePath, line: resource.line }] },
      });
      const provider = this.providerFromResourceType(resource.resourceType);
      exitPoints.push({
        id: generateNodeId('exit', relativePath, `${resourceId}:${provider}`),
        source_node: resourceId,
        source_analyzer: this.id,
        type: 'sdk',
        name: `${provider} ${resource.resourceType}`,
        description: `${resource.variable} provisions ${resource.resourceType} through ${provider}.`,
        target: { service_id: provider, resource: resource.resourceType, sdk: 'Pulumi provider' },
        operation: { action: 'provision', async: false },
        connected_nodes: [resourceId],
        metadata: { file: relativePath, provider, pulumi_resource_type: resource.resourceType },
      });

      for (const reference of this.extractVariableReferences(content, relativePath, resource, resources)) {
        edges.push({
          id: generateEdgeId(resourceId, reference.targetId, 'depends_on'),
          source: resourceId,
          target: reference.targetId,
          type: 'depends_on',
          category: 'dependency',
          metadata: { confidence: 0.8, locations: [{ file: relativePath, line: resource.line }] },
        });
      }
    }

    return { nodes, edges, entryPoints, exitPoints };
  }

  private providerFromResourceType(resourceType: string): string {
    const match = /^([a-zA-Z0-9]+)[.:]/.exec(resourceType);
    return match?.[1]?.toLowerCase() || 'pulumi';
  }

  private extractResourceDeclarations(content: string, language: string): PulumiResourceDecl[] {
    const lines = content.split(/\r?\n/);
    const results: PulumiResourceDecl[] = [];

    if (language === 'Python') {
      const pattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([a-zA-Z0-9_]+\.[A-Za-z0-9_.]+)\s*\(\s*["']([^"']+)["']/;
      lines.forEach((line, index) => {
        const match = pattern.exec(line);
        if (!match) return;
        results.push({ variable: match[1], resourceType: match[2], logicalName: match[3], line: index + 1 });
      });
      return results;
    }

    if (language === 'Go') {
      const pattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*(?:err|_)\s*:?=\s*([a-zA-Z0-9]+\.New[A-Za-z0-9_]+)\s*\(\s*ctx\s*,\s*["']([^"']+)["']/;
      lines.forEach((line, index) => {
        const match = pattern.exec(line);
        if (!match) return;
        results.push({ variable: match[1], resourceType: match[2], logicalName: match[3], line: index + 1 });
      });
      return results;
    }

    // TypeScript / JavaScript
    const pattern = /^\s*(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*new\s+([a-zA-Z0-9]+\.[A-Za-z0-9_.]+)\s*\(\s*["']([^"']+)["']/;
    lines.forEach((line, index) => {
      const match = pattern.exec(line);
      if (!match) return;
      results.push({ variable: match[1], resourceType: match[2], logicalName: match[3], line: index + 1 });
    });
    return results;
  }

  private extractVariableReferences(
    content: string,
    relativePath: string,
    resource: PulumiResourceDecl,
    allResources: PulumiResourceDecl[],
  ): Array<{ targetId: string }> {
    const references: Array<{ targetId: string }> = [];
    const bodyStart = content.split(/\r?\n/).slice(resource.line - 1, resource.line + 20).join('\n');
    for (const other of allResources) {
      if (other.variable === resource.variable) continue;
      const usagePattern = new RegExp(`\\b${escapeRegExp(other.variable)}\\.[A-Za-z0-9_]+\\b`);
      if (usagePattern.test(bodyStart)) {
        references.push({ targetId: generateNodeId('pulumi_resource', relativePath, `${other.variable}:${other.line}`) });
      }
    }
    return references;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Helm: Chart.yaml (chart identity + dependencies), values.yaml (default
// config surface), and templates/*.yaml (Kubernetes manifests using Helm
// templating `{{ .Values.x }}` / `{{ .Chart.Name }}`). Templates are parsed
// with the same lightweight technique as KubernetesManifestAnalyzer, treating
// `{{ ... }}` tokens as opaque scalars rather than failing to parse.
// ---------------------------------------------------------------------------

interface HelmTemplateResource {
  kind: string;
  nameExpr: string;
  line: number;
  ports: string[];
  isServiceLike: boolean;
}

export class HelmAnalyzer extends IacAnalyzer {
  constructor() {
    super('helm', 'Helm Chart Analyzer', '1.0.0', 'language');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const charts = await this.readFiles(projectPath, ['**/Chart.yaml', '**/Chart.yml']);
    return charts.length > 0;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const charts = await this.readFiles(projectPath, ['**/Chart.yaml', '**/Chart.yml']);
    const chartRoots = charts.map(file => path.dirname(file));
    const values = await this.readFiles(projectPath, chartRoots.map(root => `${root}/values.yaml`));
    const templates = await this.readFiles(projectPath, chartRoots.map(root => `${root}/templates/**/*.{yaml,yml}`));
    return Array.from(new Set([...charts, ...values, ...templates])).sort();
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const charts = await this.readFiles(context.projectPath, ['**/Chart.yaml', '**/Chart.yml']);
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    for (const chartFile of charts) {
      const chartResult = await this.analyzeChart(context.projectPath, chartFile);
      nodes.push(...chartResult.nodes);
      edges.push(...chartResult.edges);
      entryPoints.push(...chartResult.entryPoints);
      exitPoints.push(...chartResult.exitPoints);
    }

    return this.createContribution(nodes, edges, entryPoints, exitPoints, {
      categories: ['infrastructure', 'configuration', 'deployment'],
      infrastructure_files: nodes.length,
    });
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    if (/Chart\.ya?ml$/.test(context.relativePath)) {
      const result = await this.analyzeChart(context.projectPath, context.relativePath);
      return this.fileResult(context, result.nodes, result.edges, result.entryPoints, result.exitPoints);
    }
    // Template/values files are analyzed as part of their chart in analyze();
    // for incremental single-file mode, re-run the owning chart's analysis
    // scoped to just this file's contribution (template resources only).
    if (/templates\/.*\.ya?ml$/.test(context.relativePath)) {
      const chartRoot = context.relativePath.split('/templates/')[0];
      const chartFile = `${chartRoot}/Chart.yaml`;
      const chartName = await this.readChartName(context.projectPath, chartFile);
      const result = await this.analyzeTemplateFile(context.projectPath, context.relativePath, chartName || chartRoot, chartName || chartRoot);
      return this.fileResult(context, result.nodes, result.edges, result.entryPoints, result.exitPoints);
    }
    return this.fileResult(context, [], [], [], []);
  }

  protected getCapabilities(): string[] {
    return ['helm-chart-inventory', 'helm-template-resource-detection', 'helm-values-surface-detection'];
  }

  protected getLevelName(level: number): string {
    if (level === 1) return 'helm chart';
    if (level === 2) return 'helm values';
    return 'helm template resource';
  }

  private async readChartName(projectPath: string, chartFile: string): Promise<string | undefined> {
    try {
      const content = await fs.readFile(path.join(projectPath, chartFile), 'utf8');
      return /^name:\s*(.+)\s*$/m.exec(content)?.[1]?.trim();
    } catch {
      return undefined;
    }
  }

  private async analyzeChart(projectPath: string, chartFile: string) {
    const content = await fs.readFile(path.join(projectPath, chartFile), 'utf8');
    const chartRoot = path.dirname(chartFile);
    const chartName = /^name:\s*(.+)\s*$/m.exec(content)?.[1]?.trim() || path.basename(chartRoot);
    const chartVersion = /^version:\s*(.+)\s*$/m.exec(content)?.[1]?.trim();
    const appVersion = /^appVersion:\s*["']?([^"'\n]+)["']?\s*$/m.exec(content)?.[1]?.trim();

    const chartId = generateNodeId('helm_chart', chartFile, chartName);
    const chartNode: CASNode = {
      id: chartId,
      name: chartName,
      qualified_name: chartFile,
      type: 'helm_chart',
      category: 'infrastructure',
      level: 1,
      analyzers: [this.id],
      primaryAnalyzer: this.id,
      description: `Helm chart ${chartName}${appVersion ? ` (app version ${appVersion})` : ''}.`,
      source: { file: chartFile, line: 1, end_line: content.split('\n').length },
      metadata: {
        language: 'Helm',
        paradigm: 'declarative-infrastructure',
        attributes: {
          topology_surface: 'helm',
          chart_version: chartVersion,
          app_version: appVersion,
        },
      } as any,
      configuration: { config_files: [chartFile] },
    };

    const nodes: CASNode[] = [chartNode];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [{
      id: generateNodeId('entry', chartFile, 'helm'),
      source_node: chartId,
      source_analyzer: this.id,
      type: 'cli',
      name: `helm install ${chartName}`,
      description: `Helm deploys chart ${chartName} to a Kubernetes cluster.`,
      handler: { node_id: chartId, method_name: 'helm install/upgrade', file: chartFile, line: 1 },
      connected_nodes: [chartId],
      metadata: { language: 'Helm', chart_version: chartVersion },
    }];
    const exitPoints: CASExitPoint[] = [];

    const valuesFile = `${chartRoot}/values.yaml`;
    if (await fs.pathExists(path.join(projectPath, valuesFile))) {
      const valuesContent = await fs.readFile(path.join(projectPath, valuesFile), 'utf8');
      const valuesId = generateNodeId('helm_values', valuesFile, valuesFile);
      nodes.push({
        id: valuesId,
        name: 'values.yaml',
        qualified_name: valuesFile,
        type: 'helm_values',
        category: 'infrastructure',
        level: 2,
        analyzers: [this.id],
        primaryAnalyzer: this.id,
        description: `Default configuration values for chart ${chartName}.`,
        source: { file: valuesFile, line: 1, end_line: valuesContent.split('\n').length },
        metadata: {
          language: 'Helm',
          attributes: { topology_surface: 'helm', top_level_keys: this.topLevelKeys(valuesContent) },
        } as any,
        configuration: { config_files: [valuesFile] },
      });
      edges.push({
        id: generateEdgeId(chartId, valuesId, 'contains'),
        source: chartId,
        target: valuesId,
        type: 'contains',
        category: 'structure',
        metadata: { confidence: 0.95, locations: [{ file: valuesFile, line: 1 }] },
      });
    }

    // Common Helm naming overrides (`nameOverride` / `fullnameOverride` in
    // values.yaml) — when a template resource's `metadata.name` is an
    // unrendered `{{ ... }}` expression, these give a real, stable identifier
    // to fall back to instead of the raw template token (see
    // resolveTemplateName / the render-or-fallback doctrine below).
    let nameOverride: string | undefined;
    let fullnameOverride: string | undefined;
    if (await fs.pathExists(path.join(projectPath, valuesFile))) {
      try {
        const valuesContent = await fs.readFile(path.join(projectPath, valuesFile), 'utf8');
        nameOverride = /^nameOverride:\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/m.exec(valuesContent)?.[1]?.trim() || undefined;
        fullnameOverride = /^fullnameOverride:\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/m.exec(valuesContent)?.[1]?.trim() || undefined;
      } catch {
        // unreadable values.yaml — no overrides available, fallback naming
        // still works from chartName + kind alone.
      }
    }
    const chartBaseName = fullnameOverride || nameOverride || chartName;

    let valuesContentForCronJobs: string | undefined;
    if (await fs.pathExists(path.join(projectPath, valuesFile))) {
      try {
        valuesContentForCronJobs = await fs.readFile(path.join(projectPath, valuesFile), 'utf8');
      } catch {
        valuesContentForCronJobs = undefined;
      }
    }

    const templateFiles = await this.readFiles(projectPath, [`${chartRoot}/templates/**/*.yaml`, `${chartRoot}/templates/**/*.yml`]);
    for (const templateFile of templateFiles) {
      const templateResult = await this.analyzeTemplateFile(projectPath, templateFile, chartName, chartBaseName, valuesContentForCronJobs);
      for (const node of templateResult.nodes) {
        nodes.push(node);
        edges.push({
          id: generateEdgeId(chartId, node.id, 'contains'),
          source: chartId,
          target: node.id,
          type: 'contains',
          category: 'structure',
          metadata: { confidence: 0.9, locations: [{ file: templateFile, line: node.source?.line || 1 }] },
        });
      }
      edges.push(...templateResult.edges);
      entryPoints.push(...templateResult.entryPoints);
      exitPoints.push(...templateResult.exitPoints);
    }

    return { nodes, edges, entryPoints, exitPoints };
  }

  private topLevelKeys(content: string): string[] {
    return Array.from(new Set(
      content
        .split(/\r?\n/)
        .map(line => /^([A-Za-z0-9_-]+):/.exec(line)?.[1])
        .filter((value): value is string => Boolean(value))
    ));
  }

  private async analyzeTemplateFile(projectPath: string, templateFile: string, chartName: string, chartBaseName: string = chartName, valuesContent?: string) {
    const content = await fs.readFile(path.join(projectPath, templateFile), 'utf8');
    const resources = this.extractTemplateResources(content);
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    // Helm CronJob-via-values evidence (see findHelmCronJobsValuesKey): when
    // this template ranges over a `.Values.<key>` list to emit CronJob docs,
    // resolve the real per-job schedule/command from values.yaml instead of
    // the single ambiguous templated resource extractTemplateResources sees.
    const cronJobsValuesKey = findHelmCronJobsValuesKey(content);
    const helmValuesCronJobs = cronJobsValuesKey && valuesContent
      ? parseHelmValuesListJobs(valuesContent, cronJobsValuesKey)
      : [];

    for (const resource of resources) {
      if (resource.kind === 'CronJob' && helmValuesCronJobs.length > 0) {
        // Emit ONE node per values.yaml job entry (real, distinct identities)
        // instead of a single node for the templated resource — the source
        // template only appears once in text, but Helm's range renders N
        // CronJobs, one per values entry.
        for (const job of helmValuesCronJobs) {
          const jobLabel = job.name || 'cron-job';
          const jobNodeId = generateNodeId('helm_template_resource', templateFile, `CronJob:${jobLabel}:${resource.line}`);
          nodes.push({
            id: jobNodeId,
            name: `CronJob: ${jobLabel}-cron-job`,
            qualified_name: `${templateFile}#CronJob:${jobLabel}`,
            type: 'kubernetes_cronjob',
            category: 'infrastructure',
            level: 3,
            analyzers: [this.id],
            primaryAnalyzer: this.id,
            description: job.schedule
              ? `Helm template renders a Kubernetes CronJob "${jobLabel}" for chart ${chartName}, scheduled "${job.schedule}".`
              : `Helm template renders a Kubernetes CronJob "${jobLabel}" for chart ${chartName}.`,
            source: { file: templateFile, line: resource.line, end_line: resource.line },
            metadata: {
              language: 'Helm',
              attributes: {
                topology_surface: 'helm',
                kubernetes_kind: 'CronJob',
                chart_name: chartName,
                ports: resource.ports,
                schedule: job.schedule,
                command: job.command,
              },
            } as any,
          });
          exitPoints.push({
            id: generateNodeId('exit', templateFile, `${jobNodeId}:workload`),
            source_node: jobNodeId,
            source_analyzer: this.id,
            type: 'api',
            name: `CronJob workload (${chartName}: ${jobLabel})`,
            description: `CronJob ${jobLabel} runs the ${chartName} workload container image(s).`,
            target: { service_id: chartName, resource: 'CronJob' },
            operation: { action: 'run', async: true },
            connected_nodes: [jobNodeId],
            metadata: { language: 'Helm', kubernetes_kind: 'CronJob' },
          });
        }
        continue;
      }
      // Render-or-fallback: an un-rendered `{{ ... }}` Helm template
      // expression is never a usable name (the "hash-shaped-tokens-leak-
      // into-labels" class, Helm variant — see SPEC-DEPLOYABLE-DETECTION.md
      // §defect log). When the declared name can't be resolved statically,
      // derive a stable one from the chart's base name (fullnameOverride /
      // nameOverride / chart name) + resource kind instead of shipping the
      // raw token.
      const resolvedName = resolveTemplateResourceName(resource.nameExpr, resource.kind, chartBaseName);
      const nodeId = generateNodeId('helm_template_resource', templateFile, `${resource.kind}:${resource.nameExpr}:${resource.line}`);
      nodes.push({
        id: nodeId,
        name: `${resource.kind}: ${resolvedName}`,
        qualified_name: `${templateFile}#${resource.kind}`,
        type: `kubernetes_${resource.kind.toLowerCase()}`,
        category: 'infrastructure',
        level: 3,
        analyzers: [this.id],
        primaryAnalyzer: this.id,
        description: `Helm template renders a Kubernetes ${resource.kind} for chart ${chartName}.`,
        source: { file: templateFile, line: resource.line, end_line: resource.line },
        metadata: {
          language: 'Helm',
          attributes: {
            topology_surface: 'helm',
            kubernetes_kind: resource.kind,
            chart_name: chartName,
            ports: resource.ports,
          },
        } as any,
      });

      if (resource.isServiceLike) {
        for (const port of resource.ports.length ? resource.ports : ['80']) {
          entryPoints.push({
            id: generateNodeId('entry', templateFile, `helm-${resource.kind}-${port}`),
            source_node: nodeId,
            source_analyzer: this.id,
            type: 'http',
            name: `Helm ${resource.kind} (${chartName}) :${port}`,
            description: `Chart ${chartName} exposes a ${resource.kind} on port ${port} once templated values are resolved.`,
            trigger: { method: 'ALL', path: `http://${chartName}:${port}` },
            connected_nodes: [nodeId],
            metadata: { language: 'Helm', chart_name: chartName, port },
          });
        }
      }
      if (resource.kind === 'Deployment' || resource.kind === 'StatefulSet' || resource.kind === 'CronJob' || resource.kind === 'Job') {
        exitPoints.push({
          id: generateNodeId('exit', templateFile, `${nodeId}:workload`),
          source_node: nodeId,
          source_analyzer: this.id,
          type: 'api',
          name: `${resource.kind} workload (${chartName})`,
          description: `${resource.kind} runs the ${chartName} workload container image(s).`,
          target: { service_id: chartName, resource: resource.kind },
          operation: { action: 'run', async: true },
          connected_nodes: [nodeId],
          metadata: { language: 'Helm', kubernetes_kind: resource.kind },
        });
      }
    }

    return { nodes, edges, entryPoints, exitPoints };
  }

  private extractTemplateResources(content: string): HelmTemplateResource[] {
    const docs = content.split(/^---\s*$/m);
    const resources: HelmTemplateResource[] = [];
    let lineOffset = 0;

    for (const doc of docs) {
      const lines = doc.split(/\r?\n/);
      const kindLineIndex = lines.findIndex(line => /^\s*kind:\s*([A-Za-z0-9_.-]+)/.test(line));
      if (kindLineIndex === -1) { lineOffset += lines.length; continue; }
      const kind = /^\s*kind:\s*([A-Za-z0-9_.-]+)/.exec(lines[kindLineIndex])?.[1];
      if (!kind) { lineOffset += lines.length; continue; }

      let nameExpr = 'unknown';
      const metadataIndex = lines.findIndex(line => /^\s*metadata:\s*$/.test(line));
      if (metadataIndex !== -1) {
        for (let cursor = metadataIndex + 1; cursor < Math.min(lines.length, metadataIndex + 12); cursor++) {
          const match = lines[cursor].match(/^\s{2,}name:\s*(.+)\s*$/);
          if (match) { nameExpr = match[1].trim(); break; }
          if (/^\S/.test(lines[cursor])) break;
        }
      }

      const ports = Array.from(new Set(
        lines
          .map(line => /^\s*(?:containerPort|port|targetPort):\s*([0-9A-Za-z_.{} .]+)/.exec(line)?.[1])
          .filter((value): value is string => Boolean(value))
          .map(value => value.trim())
      ));

      resources.push({
        kind,
        nameExpr,
        line: lineOffset + kindLineIndex + 1,
        ports,
        isServiceLike: ['Service', 'Ingress'].includes(kind),
      });
      lineOffset += lines.length;
    }

    return resources;
  }
}

function cleanScalar(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '').replace(/\s*#.*$/, '').trim();
}

/** True when a Helm `metadata.name` value is an unrendered Go-template
 *  expression (`{{ include "chart.fullname" . }}`, `{{ $val.name }}`, ...)
 *  rather than a literal string. */
function isUnrenderedTemplateExpression(nameExpr: string): boolean {
  return nameExpr.includes('{{') || nameExpr.includes('}}');
}

/** Render-or-fallback naming for a Helm template resource. Never returns a
 *  raw `{{ ... }}` token: when the declared name is a template expression we
 *  can't statically evaluate, derive a stable name from the chart's base
 *  name (fullnameOverride / nameOverride / chart name, passed in as
 *  `chartBaseName`) plus the resource kind, e.g. `backend-deployment`. */
function resolveTemplateResourceName(nameExpr: string, kind: string, chartBaseName: string): string {
  if (!isUnrenderedTemplateExpression(nameExpr)) return nameExpr;
  const base = chartBaseName.trim() || 'chart';
  return `${base}-${kind.toLowerCase()}`;
}

interface HelmValuesCronJob {
  name?: string;
  schedule?: string;
  command?: string;
  enabled: boolean;
}

/**
 * Helm's `{{- range $key, $val := .Values.<key> }} ... kind: CronJob ...`
 * pattern (truckspyapp/infra/backend/templates/cron-jobs.yaml is the live
 * example) renders schedule/command from a values.yaml LIST, not literal
 * template text — extractTemplateResources sees the un-rendered `{{ }}`
 * expressions and can't recover them. This finds the `.Values.<key>` name
 * the CronJob template ranges over (co-occurring with `kind: CronJob` in the
 * same file), so the caller can resolve the real per-job schedule/command
 * from values.yaml instead of a single ambiguous templated node.
 */
function findHelmCronJobsValuesKey(templateContent: string): string | undefined {
  if (!/kind:\s*CronJob/.test(templateContent)) return undefined;
  const match = templateContent.match(/range\s+\$\w+\s*,\s*\$\w+\s*:=\s*\.Values\.(\w+)/);
  return match?.[1];
}

/**
 * Parses a top-level `values.yaml` list under `key:` into individual job
 * records — evidence-first: only `name`/`schedule`/`command`/`enabled`
 * fields actually present as literal scalars are captured (no fabrication
 * for templated or absent fields). `command` supports the inline-array form
 * (`command: [ "bin/console", "app:cron" ]`); a block-list form is not
 * parsed (rare for this key in practice) and simply yields no command for
 * that entry, which then contributes no scheduling evidence downstream.
 */
function parseHelmValuesListJobs(valuesContent: string, key: string): HelmValuesCronJob[] {
  const lines = valuesContent.split(/\r?\n/);
  const startIdx = lines.findIndex(line => new RegExp(`^${key}:\\s*(?:#.*)?$`).test(line));
  if (startIdx === -1) return [];

  const block: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break; // next top-level key
    block.push(line);
  }

  const jobs: HelmValuesCronJob[] = [];
  let current: HelmValuesCronJob | null = null;
  for (const raw of block) {
    const itemStart = raw.match(/^\s*-\s*name:\s*(.+?)\s*(?:#.*)?$/);
    if (itemStart) {
      if (current) jobs.push(current);
      current = { name: cleanScalar(itemStart[1]), enabled: true };
      continue;
    }
    if (!current) continue;
    const scheduleMatch = raw.match(/^\s+schedule:\s*(.+?)\s*(?:#.*)?$/);
    if (scheduleMatch) current.schedule = cleanScalar(scheduleMatch[1]);
    const commandMatch = raw.match(/^\s+command:\s*\[(.+?)\]\s*(?:#.*)?$/);
    if (commandMatch) {
      current.command = commandMatch[1]
        .split(',')
        .map(part => cleanScalar(part))
        .filter(Boolean)
        .join(' ');
    }
    const enabledMatch = raw.match(/^\s+enabled:\s*(true|false)\s*(?:#.*)?$/);
    if (enabledMatch) current.enabled = enabledMatch[1] === 'true';
  }
  if (current) jobs.push(current);

  return jobs.filter(job => job.enabled !== false);
}
