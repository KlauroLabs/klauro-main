import { AnalysisContext, BaseAnalyzer, FileAnalysisContext, FileAnalysisResult } from '../core/base-analyzer';
import { CASEdge, CASEntryPoint, CASExitPoint, CASNode } from '../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';
import { isHashOrIdShapedToken } from '../core/deployable-evidence/util';

interface ComposeService {
  name: string;
  image?: string;
  build?: string;
  ports: Array<{ host?: string; container: string }>;
  dependsOn: string[];
  environment: Record<string, string>;
  line: number;
}

interface KubernetesDocument {
  kind: string;
  name: string;
  line: number;
  ports: string[];
  images: string[];
  serviceNames: string[];
  env: Record<string, string>;
}

abstract class ContainerTopologyAnalyzer extends BaseAnalyzer {
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

  protected async fileResult(
    context: FileAnalysisContext,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
  ): Promise<FileAnalysisResult> {
    const content = await fs.readFile(context.filePath, 'utf8');
    const stat = await fs.stat(context.filePath);
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
      []
    );
  }
}

export class DockerfileAnalyzer extends ContainerTopologyAnalyzer {
  constructor() {
    super('dockerfile', 'Dockerfile Analyzer', '1.0.0', 'language');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    return (await this.getRelevantFiles(projectPath)).length > 0;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    return this.readFiles(projectPath, ['Dockerfile', 'Dockerfile.*', '**/Dockerfile', '**/Dockerfile.*', '**/*.Dockerfile']);
  }

  async analyze(context: AnalysisContext) {
    const files = await this.getRelevantFiles(context.projectPath);
    const nodes: CASNode[] = [];
    const entryPoints: CASEntryPoint[] = [];
    for (const relativeFile of files) {
      const parsed = await this.analyzeDockerfile(context.projectPath, relativeFile);
      nodes.push(...parsed.nodes);
      entryPoints.push(...parsed.entryPoints);
    }
    return this.createContribution(nodes, [], entryPoints, [], {
      topology_surface: 'container-image',
      dockerfiles: files.length,
    });
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const parsed = await this.analyzeDockerfile(context.projectPath, context.relativePath);
    return this.fileResult(context, parsed.nodes, [], parsed.entryPoints, []);
  }

  protected getCapabilities(): string[] {
    return ['dockerfile-runtime-topology', 'container-base-image-detection', 'container-exposed-port-detection'];
  }

  protected getLevelName(level: number): string {
    return level <= 3 ? 'container topology' : 'container detail';
  }

  private async analyzeDockerfile(projectPath: string, relativeFile: string) {
    const content = await fs.readFile(path.join(projectPath, relativeFile), 'utf8');
    const lines = content.split(/\r?\n/);
    const baseImages = collectDockerInstruction(lines, 'FROM');
    const ports = collectDockerInstruction(lines, 'EXPOSE').flatMap(value => value.split(/\s+/)).filter(Boolean);
    const commands = collectDockerInstruction(lines, 'CMD').concat(collectDockerInstruction(lines, 'ENTRYPOINT'));
    const nodeId = `dockerfile_${this.sanitizeId(relativeFile)}`;
    const nodes = [
      this.createNode(nodeId, `Docker image definition: ${relativeFile}`, 'container_image_definition', 3, relativeFile, 1, lines.length, {
        topology_surface: 'dockerfile',
        base_images: baseImages,
        exposed_ports: ports,
        command: commands[0],
        service_aliases: [inferServiceName(projectPath, relativeFile)],
        subcategories: ['container-topology', 'dockerfile'],
      }),
    ];
    // A Dockerfile EXPOSE is DEPLOYMENT topology (the image's port), not an
    // inbound application entry point. The ports are preserved on the node's
    // exposed_ports metadata for deployable/runtime detection. Application entry
    // points come from code analyzers (routes, CLI, event handlers).
    const entryPoints: CASEntryPoint[] = [];
    return { nodes, entryPoints };
  }
}

export class DockerComposeAnalyzer extends ContainerTopologyAnalyzer {
  constructor() {
    super('docker-compose', 'Docker Compose Analyzer', '1.0.0', 'language');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    return (await this.getRelevantFiles(projectPath)).length > 0;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    return this.readFiles(projectPath, [
      'compose.yml',
      'compose.yaml',
      'docker-compose.yml',
      'docker-compose.yaml',
      'docker-compose.*.yml',
      'docker-compose.*.yaml',
      '**/compose.yml',
      '**/compose.yaml',
      '**/docker-compose.yml',
      '**/docker-compose.yaml',
      '**/docker-compose.*.yml',
      '**/docker-compose.*.yaml',
    ]);
  }

  async analyze(context: AnalysisContext) {
    const files = await this.getRelevantFiles(context.projectPath);
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    for (const relativeFile of files) {
      const parsed = await this.analyzeComposeFile(context.projectPath, relativeFile);
      nodes.push(...parsed.nodes);
      edges.push(...parsed.edges);
      entryPoints.push(...parsed.entryPoints);
      exitPoints.push(...parsed.exitPoints);
    }
    return this.createContribution(nodes, edges, entryPoints, exitPoints, {
      topology_surface: 'docker-compose',
      compose_files: files.length,
    });
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const parsed = await this.analyzeComposeFile(context.projectPath, context.relativePath);
    return this.fileResult(context, parsed.nodes, parsed.edges, parsed.entryPoints, parsed.exitPoints);
  }

  protected getCapabilities(): string[] {
    return ['compose-service-topology', 'compose-dependency-wiring', 'compose-port-and-env-contracts'];
  }

  protected getLevelName(level: number): string {
    return level <= 3 ? 'compose topology' : 'compose service detail';
  }

  private async analyzeComposeFile(projectPath: string, relativeFile: string) {
    const content = await fs.readFile(path.join(projectPath, relativeFile), 'utf8');
    const services = parseComposeServices(content);
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    for (const service of services) {
      const nodeId = `compose_service_${this.sanitizeId(relativeFile)}_${this.sanitizeId(service.name)}`;
      nodes.push(this.createNode(nodeId, `Compose service: ${service.name}`, 'compose_service', 3, relativeFile, service.line, service.line, {
        topology_surface: 'docker-compose',
        deployment_service_name: service.name,
        service_aliases: [service.name],
        image: service.image,
        build: service.build,
        ports: service.ports,
        depends_on: service.dependsOn,
        environment_keys: Object.keys(service.environment),
        subcategories: ['container-topology', 'docker-compose', 'runtime-service'],
      }));

      // Compose port exposures are DEPLOYMENT topology, not inbound application
      // entry points (the ports are preserved on the node metadata above). The
      // app's real entry points come from code analyzers (routes/CLI/handlers).
      // Image-only services (postgres, redis, ethereum-node, bitcoin-node, …) are
      // EXTERNAL dependencies the app connects to — record them as external
      // services so the dependency is visible. Counting any of these as entry
      // points was corrupting journeys/flows/capabilities ("Bitcoin Node:8332"
      // and "Soon Lens:8545" became primary workflows).
      const isOwnBuiltService = Boolean(service.build);
      if (!isOwnBuiltService) {
        const exposedPorts = service.ports.length ? service.ports : [{ container: '' }];
        for (const port of exposedPorts) {
          const normalizedPort = normalizePort(port.container);
          const endpoint = normalizedPort ? `http://${service.name}:${normalizedPort}` : `http://${service.name}`;
          exitPoints.push(this.createExitPoint(
            `exit_compose_service_${this.sanitizeId(relativeFile)}_${this.sanitizeId(service.name)}_${normalizedPort || 'service'}`,
            nodeId,
            'api',
            normalizedPort ? `External service ${service.name}:${normalizedPort}` : `External service ${service.name}`,
            `${service.name} is an external/runtime service this workspace connects to${normalizedPort ? ` on port ${normalizedPort}` : ''} (compose image: ${service.image || 'unknown'}).`,
            { service_id: service.name, endpoint, resource: service.name },
            { action: 'external-service', async: false },
            {
              topology_surface: 'docker-compose',
              deployment_service_name: service.name,
              service_aliases: [service.name],
              port: normalizedPort || undefined,
              image: service.image,
            }
          ));
        }
      }

      for (const dependency of service.dependsOn) {
        const targetNodeId = `compose_service_${this.sanitizeId(relativeFile)}_${this.sanitizeId(dependency)}`;
        edges.push(this.createEdge(
          `edge_compose_dep_${this.sanitizeId(service.name)}_${this.sanitizeId(dependency)}`,
          nodeId,
          targetNodeId,
          'DEPENDS_ON',
          'runtime',
          { topology_surface: 'docker-compose', dependency_kind: 'compose-service' }
        ));
        exitPoints.push(this.createExitPoint(
          `exit_compose_dep_${this.sanitizeId(relativeFile)}_${this.sanitizeId(service.name)}_${this.sanitizeId(dependency)}`,
          nodeId,
          'api',
          `Compose dependency ${service.name} -> ${dependency}`,
          `Compose service ${service.name} depends on ${dependency}.`,
          { service_id: dependency, endpoint: `http://${dependency}`, resource: dependency },
          { action: 'service-dependency', async: false },
          {
            topology_surface: 'docker-compose',
            deployment_service_name: dependency,
            service_aliases: [dependency],
          }
        ));
      }

      for (const [key, value] of Object.entries(service.environment)) {
        const targetService = inferServiceReference(key, value);
        if (!targetService) continue;
        exitPoints.push(this.createExitPoint(
          `exit_compose_env_${this.sanitizeId(relativeFile)}_${this.sanitizeId(service.name)}_${this.sanitizeId(key)}`,
          nodeId,
          'api',
          `Compose env reference ${service.name} -> ${targetService}`,
          `Compose service ${service.name} references ${targetService} through ${key}.`,
          { service_id: targetService, endpoint: `http://${targetService}`, resource: targetService },
          { action: 'service-reference', async: false },
          {
            topology_surface: 'docker-compose',
            deployment_service_name: targetService,
            service_aliases: [targetService],
            env_key: key,
          }
        ));
      }
    }

    return { nodes, edges, entryPoints, exitPoints };
  }
}

export class KubernetesManifestAnalyzer extends ContainerTopologyAnalyzer {
  constructor() {
    super('kubernetes-manifest', 'Kubernetes Manifest Analyzer', '1.0.0', 'language');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    return (await this.getRelevantFiles(projectPath)).length > 0;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    return this.readFiles(projectPath, [
      'k8s/**/*.{yml,yaml}',
      'kubernetes/**/*.{yml,yaml}',
      'deploy/**/*.{yml,yaml}',
      'deployment/**/*.{yml,yaml}',
      'deployments/**/*.{yml,yaml}',
      'manifests/**/*.{yml,yaml}',
      'charts/**/*.{yml,yaml}',
    ]);
  }

  async analyze(context: AnalysisContext) {
    const files = await this.getRelevantFiles(context.projectPath);
    const nodes: CASNode[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    for (const relativeFile of files) {
      const parsed = await this.analyzeManifest(context.projectPath, relativeFile);
      nodes.push(...parsed.nodes);
      entryPoints.push(...parsed.entryPoints);
      exitPoints.push(...parsed.exitPoints);
    }
    return this.createContribution(nodes, [], entryPoints, exitPoints, {
      topology_surface: 'kubernetes',
      manifest_files: files.length,
    });
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const parsed = await this.analyzeManifest(context.projectPath, context.relativePath);
    return this.fileResult(context, parsed.nodes, [], parsed.entryPoints, parsed.exitPoints);
  }

  protected getCapabilities(): string[] {
    return ['kubernetes-workload-topology', 'kubernetes-service-and-ingress-detection', 'kubernetes-env-reference-detection'];
  }

  protected getLevelName(level: number): string {
    return level <= 3 ? 'kubernetes topology' : 'kubernetes resource detail';
  }

  private async analyzeManifest(projectPath: string, relativeFile: string) {
    const content = await fs.readFile(path.join(projectPath, relativeFile), 'utf8');
    const documents = parseKubernetesDocuments(content);
    const nodes: CASNode[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    for (const document of documents) {
      const nodeId = `k8s_${this.sanitizeId(relativeFile)}_${this.sanitizeId(document.kind)}_${this.sanitizeId(document.name)}`;
      nodes.push(this.createNode(nodeId, `${document.kind}: ${document.name}`, `kubernetes_${document.kind.toLowerCase()}`, 3, relativeFile, document.line, document.line, {
        topology_surface: 'kubernetes',
        kubernetes_kind: document.kind,
        deployment_service_name: document.name,
        service_aliases: [document.name, ...document.serviceNames],
        ports: document.ports,
        images: document.images,
        environment_keys: Object.keys(document.env),
        subcategories: ['container-topology', 'kubernetes', document.kind.toLowerCase()],
      }));

      if (['Service', 'Ingress'].includes(document.kind)) {
        for (const port of document.ports.length ? document.ports : ['80']) {
          entryPoints.push(this.createEntryPoint(
            `entry_k8s_${this.sanitizeId(relativeFile)}_${this.sanitizeId(document.name)}_${normalizePort(port)}`,
            nodeId,
            'http',
            `Kubernetes ${document.kind} ${document.name}:${normalizePort(port)}`,
            `Kubernetes ${document.kind} ${document.name} exposes port ${normalizePort(port)}.`,
            { method: 'ALL', path: `http://${document.name}:${normalizePort(port)}` },
            undefined,
            {
              topology_surface: 'kubernetes',
              deployment_service_name: document.name,
              service_aliases: [document.name, ...document.serviceNames],
              port: normalizePort(port),
            }
          ));
        }
      }

      for (const [key, value] of Object.entries(document.env)) {
        const targetService = inferServiceReference(key, value);
        if (!targetService) continue;
        exitPoints.push(this.createExitPoint(
          `exit_k8s_env_${this.sanitizeId(relativeFile)}_${this.sanitizeId(document.name)}_${this.sanitizeId(key)}`,
          nodeId,
          'api',
          `Kubernetes env reference ${document.name} -> ${targetService}`,
          `Kubernetes resource ${document.name} references ${targetService} through ${key}.`,
          { service_id: targetService, endpoint: `http://${targetService}`, resource: targetService },
          { action: 'service-reference', async: false },
          {
            topology_surface: 'kubernetes',
            deployment_service_name: targetService,
            service_aliases: [targetService],
            env_key: key,
          }
        ));
      }
    }

    return { nodes, entryPoints, exitPoints };
  }
}

function collectDockerInstruction(lines: string[], instruction: string): string[] {
  const pattern = new RegExp(`^\\s*${instruction}\\s+(.+)$`, 'i');
  return lines.map(line => line.match(pattern)?.[1]?.trim()).filter(Boolean) as string[];
}

function parseComposeServices(content: string): ComposeService[] {
  const lines = content.split(/\r?\n/);
  const services: ComposeService[] = [];
  let inServices = false;
  let current: ComposeService | null = null;
  let currentList: 'ports' | 'depends_on' | 'environment' | null = null;

  const flush = () => {
    if (current) services.push(current);
    current = null;
    currentList = null;
  };

  lines.forEach((line, index) => {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      return;
    }
    if (inServices && /^\S/.test(line) && !/^services:\s*$/.test(line)) {
      flush();
      inServices = false;
    }
    if (!inServices) return;

    const serviceMatch = line.match(/^\s{2}([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
    if (serviceMatch) {
      flush();
      current = { name: serviceMatch[1], ports: [], dependsOn: [], environment: {}, line: index + 1 };
      return;
    }
    if (!current) return;

    const keyMatch = line.match(/^\s{4}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyMatch) {
      currentList = null;
      const [, key, rawValue] = keyMatch;
      const value = cleanYamlScalar(rawValue);
      if (key === 'image') current.image = value;
      else if (key === 'build') current.build = value;
      else if (key === 'ports') currentList = 'ports';
      else if (key === 'depends_on') {
        currentList = 'depends_on';
        for (const dep of parseInlineList(value)) current.dependsOn.push(dep);
      } else if (key === 'environment') currentList = 'environment';
      return;
    }

    if (currentList === 'ports') {
      const value = line.match(/^\s{6}-\s*(.+)$/)?.[1];
      if (value) {
        const parsed = parsePortMapping(cleanYamlScalar(value));
        if (parsed) current.ports.push(parsed);
      }
    } else if (currentList === 'depends_on') {
      const value = line.match(/^\s{6}-\s*(.+)$/)?.[1] || line.match(/^\s{6}([A-Za-z0-9_.-]+):/)?.[1];
      if (value) current.dependsOn.push(cleanYamlScalar(value));
    } else if (currentList === 'environment') {
      const listValue = line.match(/^\s{6}-\s*([A-Za-z0-9_]+)=(.+)$/);
      const mapValue = line.match(/^\s{6}([A-Za-z0-9_]+):\s*(.+)$/);
      if (listValue) current.environment[listValue[1]] = cleanYamlScalar(listValue[2]);
      if (mapValue) current.environment[mapValue[1]] = cleanYamlScalar(mapValue[2]);
    }
  });
  flush();
  return services;
}

function parseKubernetesDocuments(content: string): KubernetesDocument[] {
  const docs: KubernetesDocument[] = [];
  let offset = 0;
  for (const doc of content.split(/^---\s*$/m)) {
    const lines = doc.split(/\r?\n/);
    const kind = firstMatch(lines, /^\s*kind:\s*([A-Za-z0-9_.-]+)\s*$/);
    const name = firstMetadataName(lines);
    if (!kind || !name) {
      offset += lines.length;
      continue;
    }
    docs.push({
      kind,
      name,
      line: offset + Math.max(1, lines.findIndex(line => /^\s*kind:\s*/.test(line)) + 1),
      ports: collectMatches(lines, /^\s*(?:containerPort|port|targetPort):\s*([0-9A-Za-z_.-]+)/),
      images: collectMatches(lines, /^\s*image:\s*([^#\s]+)/),
      serviceNames: collectMatches(lines, /^\s*(?:app|app\.kubernetes\.io\/name|service):\s*([A-Za-z0-9_.-]+)/),
      env: collectKubernetesEnv(lines),
    });
    offset += lines.length;
  }
  return docs;
}

function firstMetadataName(lines: string[]): string | undefined {
  for (let index = 0; index < lines.length; index++) {
    if (!/^\s*metadata:\s*$/.test(lines[index])) continue;
    for (let cursor = index + 1; cursor < Math.min(lines.length, index + 12); cursor++) {
      const match = lines[cursor].match(/^\s{2,}name:\s*([A-Za-z0-9_.-]+)/);
      if (match) return match[1];
      if (/^\S/.test(lines[cursor])) break;
    }
  }
  return undefined;
}

function collectKubernetesEnv(lines: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  let currentName = '';
  for (const line of lines) {
    const name = line.match(/^\s*-\s*name:\s*([A-Za-z0-9_]+)/)?.[1];
    if (name) {
      currentName = name;
      continue;
    }
    const value = line.match(/^\s*value:\s*["']?([^"']+)["']?/)?.[1];
    if (currentName && value) {
      env[currentName] = value;
      currentName = '';
    }
  }
  return env;
}

function firstMatch(lines: string[], pattern: RegExp): string | undefined {
  for (const line of lines) {
    const match = line.match(pattern);
    if (match) return cleanYamlScalar(match[1]);
  }
  return undefined;
}

function collectMatches(lines: string[], pattern: RegExp): string[] {
  return [...new Set(lines.map(line => line.match(pattern)?.[1]).filter(Boolean).map(value => cleanYamlScalar(String(value))))];
}

function parseInlineList(value: string): string[] {
  if (!value || !value.startsWith('[')) return [];
  return value.replace(/^\[|\]$/g, '').split(',').map(item => cleanYamlScalar(item)).filter(Boolean);
}

function parsePortMapping(value: string): { host?: string; container: string } | null {
  const cleaned = value.replace(/\/tcp$|\/udp$/i, '');
  const parts = cleaned.split(':').map(part => part.trim()).filter(Boolean);
  if (parts.length === 1) return { container: parts[0] };
  if (parts.length >= 2) return { host: parts[parts.length - 2], container: parts[parts.length - 1] };
  return null;
}

function cleanYamlScalar(value: string): string {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '').replace(/\s+#.*$/, '');
}

function normalizePort(value: string): string {
  return cleanYamlScalar(value).replace(/\/tcp$|\/udp$/i, '');
}

function inferServiceName(projectPath: string, relativeFile: string): string {
  // Production analyze snapshots the source to an on-disk dir named after the
  // analysisId HASH, so path.basename(projectPath) can be hash-shaped rather
  // than a real service name. Prefer it when it's a legitimate name; when
  // it's hash/id-shaped, fall back to the Dockerfile's own containing
  // directory name (still real, just less specific), and only as a last
  // resort to a stable non-hash placeholder — never emit the hash.
  const projectBase = path.basename(projectPath);
  const dockerfileDir = path.basename(path.dirname(relativeFile));
  let base: string;
  if (projectBase && !isHashOrIdShapedToken(projectBase)) {
    base = projectBase;
  } else if (dockerfileDir && dockerfileDir !== '.' && !isHashOrIdShapedToken(dockerfileDir)) {
    base = dockerfileDir;
  } else {
    base = 'unnamed-service';
  }
  return base.replace(/[^a-zA-Z0-9_.-]/g, '-').toLowerCase();
}

function inferServiceReference(key: string, value: string): string | null {
  const combined = `${key} ${value}`.trim();
  const urlHost = value.match(/^https?:\/\/([A-Za-z0-9_.-]+)/)?.[1];
  if (urlHost && !isExternalHost(urlHost)) return urlHost;
  const serviceKey = key.match(/^([A-Za-z0-9_]+)_(?:URL|URI|HOST|ENDPOINT|SERVICE)$/i)?.[1];
  if (serviceKey) return serviceKey.toLowerCase().replace(/_/g, '-');
  const serviceValue = combined.match(/\b([a-z0-9][a-z0-9_.-]+)\.(?:svc|service|local)\b/i)?.[1];
  if (serviceValue) return serviceValue.toLowerCase();
  return null;
}

function isExternalHost(value: string): boolean {
  return /\./.test(value) && !/\.local$|\.svc$|\.internal$/.test(value);
}
