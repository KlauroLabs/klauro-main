import { AnalysisContext, BaseAnalyzer, FileAnalysisContext, FileAnalysisResult } from '../core/base-analyzer';
import { CASEdge, CASEntryPoint, CASExitPoint, CASNode } from '../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../core/glob-cache';
import * as yaml from 'js-yaml';
import { isHashOrIdShapedToken, isIdentifierShapedRepoBasename, UNNAMED_SERVICE_PLACEHOLDER } from '../core/deployable-evidence/util';

interface ComposeService {
  name: string;
  image?: string;
  build?: string;
  /** The object-form `build.dockerfile` path, when present — reliably
   *  repo-relative (unlike `build.context`, which real compose files
   *  sometimes point at an absolute deploy-time path outside the analyzed
   *  tree, e.g. a VPS rsync destination). See composeBuildContext below. */
  dockerfile?: string;
  ports: Array<{ host?: string; container: string }>;
  dependsOn: string[];
  environment: Record<string, string>;
  volumes: string[];
  networks: string[];
  line: number;
}

interface KubernetesDocument {
  kind: string;
  name: string;
  line: number;
  ports: string[];
  servicePorts: Array<{ port?: string; targetPort?: string; name?: string }>;
  selector: Record<string, string>;
  labels: Record<string, string>;
  replicas?: number;
  images: string[];
  serviceNames: string[];
  env: Record<string, string>;
  ingressBackends: Array<{ host?: string; path?: string; service: string; port?: string }>;
  /** CronJob-only: `spec.schedule`, the cron expression — the deterministic
   *  ground for classifying a linked command entry point as `scheduled`
   *  (journey-builder.ts CRON_COMMAND_ENTRY_TYPES). */
  schedule?: string;
  /** Workload container `command` + `args`, concatenated into one evidence
   *  string (e.g. `bin/console app:cron:process`) — the deterministic ground
   *  for linking a CronJob to the console-command entry point it runs. */
  command?: string;
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
    const stages = parseDockerfileStages(lines);
    const baseImages = stages.map(stage => stage.image);
    const ports = collectDockerInstruction(lines, 'EXPOSE').flatMap(value => value.split(/\s+/)).filter(Boolean);
    const cmdInstructions = collectDockerInstruction(lines, 'CMD');
    const entrypointInstructions = collectDockerInstruction(lines, 'ENTRYPOINT');
    const copySources = collectDockerCopySources(lines, 'COPY');
    const addSources = collectDockerCopySources(lines, 'ADD');
    const workdirInstructions = collectDockerInstruction(lines, 'WORKDIR');
    const cmd = lastValue(cmdInstructions);
    const entrypoint = lastValue(entrypointInstructions);
    const workdir = lastValue(workdirInstructions);
    const nodeId = `dockerfile_${this.sanitizeId(relativeFile)}`;
    const nodes = [
      this.createNode(nodeId, `Docker image definition: ${relativeFile}`, 'container_image_definition', 3, relativeFile, 1, lines.length, {
        topology_surface: 'dockerfile',
        base_images: baseImages,
        stages,
        exposed_ports: ports,
        entrypoint,
        cmd,
        command: entrypoint || cmd,
        copy_sources: copySources,
        add_sources: addSources,
        workdir,
        build_context: path.dirname(relativeFile) === '.' ? '' : path.dirname(relativeFile),
        service_aliases: inferServiceAliases(projectPath, relativeFile, entrypoint || cmd),
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
    // ANY service declared in this same compose file — built or pulled-image
    // — already gets its own representation: an own-built service is app
    // topology (edges only, no exit point); a pulled-image service already
    // emits its OWN direct "External service <name>" exit point below (from
    // the exposed-ports loop). A depends_on/env reference pointing at either
    // would just duplicate that existing signal under a second, differently
    // shaped label ("Compose dependency X -> Y") — noise, not new evidence.
    // Only a reference to a name this file never declares as a service (no
    // other evidence of it at all) is worth its own exit point.
    const allServiceNames = new Set(services.map(s => s.name));

    for (const service of services) {
      const nodeId = `compose_service_${this.sanitizeId(relativeFile)}_${this.sanitizeId(service.name)}`;
      nodes.push(this.createNode(nodeId, `Compose service: ${service.name}`, 'compose_service', 3, relativeFile, service.line, service.line, {
        topology_surface: 'docker-compose',
        deployment_service_name: service.name,
        service_aliases: [service.name],
        image: service.image,
        build: service.build,
        dockerfile: service.dockerfile,
        ports: service.ports,
        depends_on: service.dependsOn,
        environment_keys: Object.keys(service.environment),
        volumes: service.volumes,
        networks: service.networks,
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
        // Only emit the exit point when the dependency does NOT name another
        // service declared in this same file — that target already has its
        // own representation (own-topology edge, or its own direct external-
        // service exit point below), so this would just be a duplicate.
        if (!allServiceNames.has(dependency)) {
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
      }

      for (const [key, value] of Object.entries(service.environment)) {
        const targetService = inferServiceReference(key, value);
        if (!targetService) continue;
        // Same duplicate-signal guard as the depends_on loop above: an env
        // var pointing at a service already declared in this file is
        // already represented elsewhere, not new evidence.
        if (allServiceNames.has(targetService)) continue;
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
      '**/*.{yml,yaml}',
    ]);
  }

  async analyze(context: AnalysisContext) {
    const files = await this.getRelevantFiles(context.projectPath);
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    for (const relativeFile of files) {
      const parsed = await this.analyzeManifest(context.projectPath, relativeFile);
      nodes.push(...parsed.nodes);
      edges.push(...parsed.edges);
      entryPoints.push(...parsed.entryPoints);
      exitPoints.push(...parsed.exitPoints);
    }
    return this.createContribution(nodes, edges, entryPoints, exitPoints, {
      topology_surface: 'kubernetes',
      manifest_files: files.length,
    });
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const parsed = await this.analyzeManifest(context.projectPath, context.relativePath);
    return this.fileResult(context, parsed.nodes, parsed.edges, parsed.entryPoints, parsed.exitPoints);
  }

  protected getCapabilities(): string[] {
    return ['kubernetes-workload-topology', 'kubernetes-service-and-ingress-detection', 'kubernetes-env-reference-detection'];
  }

  protected getLevelName(level: number): string {
    return level <= 3 ? 'kubernetes topology' : 'kubernetes resource detail';
  }

  private async analyzeManifest(projectPath: string, relativeFile: string) {
    if (isHelmTemplatePath(relativeFile)) return { nodes: [], edges: [], entryPoints: [], exitPoints: [] };
    const content = await fs.readFile(path.join(projectPath, relativeFile), 'utf8');
    const documents = parseKubernetesDocuments(content);
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const idByKindAndName = new Map<string, string>();

    for (const document of documents) {
      const nodeId = `k8s_${this.sanitizeId(relativeFile)}_${this.sanitizeId(document.kind)}_${this.sanitizeId(document.name)}`;
      idByKindAndName.set(`${document.kind}:${document.name}`, nodeId);
      nodes.push(this.createNode(nodeId, `${document.kind}: ${document.name}`, `kubernetes_${document.kind.toLowerCase()}`, 3, relativeFile, document.line, document.line, {
        topology_surface: 'kubernetes',
        kubernetes_kind: document.kind,
        deployment_service_name: document.name,
        service_aliases: [document.name, ...document.serviceNames],
        ports: document.ports,
        service_ports: document.servicePorts,
        selector: document.selector,
        labels: document.labels,
        replicas: document.replicas,
        images: document.images,
        environment_keys: Object.keys(document.env),
        env: document.env,
        ingress_backends: document.ingressBackends,
        schedule: document.schedule,
        command: document.command,
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

    for (const source of documents) {
      if (source.kind === 'Ingress') {
        const sourceId = idByKindAndName.get(`${source.kind}:${source.name}`);
        if (!sourceId) continue;
        for (const backend of source.ingressBackends) {
          const serviceId = idByKindAndName.get(`Service:${backend.service}`);
          if (!serviceId) continue;
          edges.push(this.createEdge(
            `edge_k8s_ingress_${this.sanitizeId(relativeFile)}_${this.sanitizeId(source.name)}_${this.sanitizeId(backend.service)}`,
            sourceId,
            serviceId,
            'ROUTES_TO',
            'runtime',
            { topology_surface: 'kubernetes', host: backend.host, path: backend.path, port: backend.port }
          ));
        }
      }

      if (source.kind === 'Service') {
        const sourceId = idByKindAndName.get(`${source.kind}:${source.name}`);
        if (!sourceId || Object.keys(source.selector).length === 0) continue;
        for (const target of documents) {
          if (!['Deployment', 'StatefulSet', 'DaemonSet'].includes(target.kind)) continue;
          if (!selectorMatchesLabels(source.selector, target.labels)) continue;
          const targetId = idByKindAndName.get(`${target.kind}:${target.name}`);
          if (!targetId) continue;
          edges.push(this.createEdge(
            `edge_k8s_service_${this.sanitizeId(relativeFile)}_${this.sanitizeId(source.name)}_${this.sanitizeId(target.name)}`,
            sourceId,
            targetId,
            'ROUTES_TO',
            'runtime',
            { topology_surface: 'kubernetes', selector: source.selector }
          ));
        }
      }
    }

    return { nodes, edges, entryPoints, exitPoints };
  }
}

interface DockerfileStage {
  image: string;
  alias?: string;
  line: number;
}

function parseDockerfileStages(lines: string[]): DockerfileStage[] {
  const stages: DockerfileStage[] = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\s*FROM\s+([^\s]+)(?:\s+AS\s+([A-Za-z0-9_.-]+))?/i);
    if (match) stages.push({ image: match[1], alias: match[2], line: index + 1 });
  }
  return stages;
}

function collectDockerCopySources(lines: string[], instruction: 'COPY' | 'ADD'): string[] {
  const sources = new Set<string>();
  const pattern = new RegExp(`^\\s*${instruction}\\s+(.+)$`, 'i');
  for (const line of lines) {
    const raw = line.match(pattern)?.[1]?.trim();
    if (!raw) continue;
    const withoutFlags = raw.replace(/^(?:--[A-Za-z0-9_-]+(?:=(?:"[^"]+"|'[^']+'|\S+))?\s+)+/, '');
    if (withoutFlags.startsWith('[')) {
      try {
        const parsed = JSON.parse(withoutFlags);
        if (Array.isArray(parsed)) {
          parsed.slice(0, -1).filter(value => typeof value === 'string').forEach(value => sources.add(value));
        }
      } catch {
      }
      continue;
    }
    const parts = withoutFlags.split(/\s+/).filter(Boolean);
    parts.slice(0, -1).forEach(value => sources.add(value));
  }
  return Array.from(sources);
}

function collectDockerInstruction(lines: string[], instruction: string): string[] {
  const pattern = new RegExp(`^\\s*${instruction}\\s+(.+)$`, 'i');
  return lines.map(line => line.match(pattern)?.[1]?.trim()).filter(Boolean) as string[];
}

function parseComposeServices(content: string): ComposeService[] {
  const parsed = parseComposeServicesFromYaml(content);
  if (parsed.length > 0) return parsed;

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
      current = { name: serviceMatch[1], ports: [], dependsOn: [], environment: {}, volumes: [], networks: [], line: index + 1 };
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

function parseComposeServicesFromYaml(content: string): ComposeService[] {
  const doc = safeLoadYaml(content);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return [];
  const services = (doc as any).services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) return [];
  const lines = content.split(/\r?\n/);

  return Object.entries(services).map(([name, raw]) => {
    const service = raw && typeof raw === 'object' ? raw as Record<string, any> : {};
    return {
      name,
      image: stringValue(service.image),
      build: composeBuildContext(service.build),
      dockerfile: composeBuildDockerfile(service.build),
      ports: composePorts(service.ports),
      dependsOn: composeDependsOn(service.depends_on),
      environment: composeEnvironment(service.environment),
      volumes: stringList(service.volumes),
      networks: stringList(service.networks),
      line: findYamlKeyLine(lines, name),
    };
  });
}

function composeBuildContext(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  // Object-form `build:` (context/dockerfile/args) still means "this
  // compose file builds the service" even when `context` is omitted — compose
  // defaults an omitted context to the compose file's own directory. Losing
  // the object here (falling through to undefined) made `Boolean(service.build)`
  // false and misclassified an own-built service as a pulled/external image
  // (e.g. `build: { dockerfile: docker/php.Dockerfile }` with no `context`).
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return stringValue((value as any).context) || '.';
  }
  return undefined;
}

/** The object-form `build.dockerfile` path, when present. Unlike `context`
 *  (which real compose files sometimes point at an absolute deploy-time path
 *  outside the analyzed tree — e.g. `context: /opt/klauro/source` on a
 *  production host, meaningless relative to the repo this analyzer is
 *  walking), `dockerfile` is always a plain repo-relative path to the actual
 *  Dockerfile compose builds, and root_path resolution below prefers it for
 *  exactly that reason. */
function composeBuildDockerfile(value: unknown): string | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return stringValue((value as any).dockerfile);
  }
  return undefined;
}

function composePorts(value: unknown): Array<{ host?: string; container: string }> {
  if (!Array.isArray(value)) return [];
  return value.map(port => {
    if (typeof port === 'number') return { container: String(port) };
    if (typeof port === 'string') return parsePortMapping(cleanYamlScalar(port));
    if (port && typeof port === 'object') {
      const target = stringValue((port as any).target);
      if (!target) return null;
      return { host: stringValue((port as any).published), container: target };
    }
    return null;
  }).filter((port): port is { host?: string; container: string } => Boolean(port));
}

function composeDependsOn(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value && typeof value === 'object') return Object.keys(value);
  return [];
}

function composeEnvironment(value: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const item of value) {
      const [key, ...rest] = String(item).split('=');
      if (key && rest.length > 0) env[key] = rest.join('=');
    }
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      env[key] = item == null ? '' : String(item);
    }
  }
  return env;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : stringValue((item as any)?.source) || stringValue((item as any)?.target) || '').filter(Boolean);
  if (value && typeof value === 'object') return Object.keys(value);
  return [];
}

function parseKubernetesDocuments(content: string): KubernetesDocument[] {
  const parsed = parseKubernetesDocumentsFromYaml(content);
  if (parsed.length > 0) return parsed;

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
      servicePorts: [],
      selector: {},
      labels: {},
      images: collectMatches(lines, /^\s*image:\s*([^#\s]+)/),
      serviceNames: collectMatches(lines, /^\s*(?:app|app\.kubernetes\.io\/name|service):\s*([A-Za-z0-9_.-]+)/),
      env: collectKubernetesEnv(lines),
      ingressBackends: [],
      schedule: kind === 'CronJob' ? firstMatch(lines, /^\s*schedule:\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?$/) : undefined,
      // command/args are left unextracted on this malformed-YAML fallback
      // path — a bare `- item` line regex is too ambiguous with ports/env
      // list entries to trust as command evidence (no fabrication).
      command: undefined,
    });
    offset += lines.length;
  }
  return docs;
}

function parseKubernetesDocumentsFromYaml(content: string): KubernetesDocument[] {
  const resources: KubernetesDocument[] = [];
  const lineLookup = content.split(/\r?\n/);
  try {
    yaml.loadAll(content, doc => {
      if (!isRecord(doc)) return;
      const kind = stringValue(doc.kind);
      const apiVersion = stringValue(doc.apiVersion);
      const metadata = isRecord(doc.metadata) ? doc.metadata : {};
      const name = stringValue(metadata.name);
      if (!apiVersion || !kind || !name || !SUPPORTED_KUBERNETES_KINDS.has(kind)) return;
      const spec = isRecord(doc.spec) ? doc.spec : {};
      const podSpec = extractPodSpec(kind, spec);
      const containerList = Array.isArray(podSpec?.containers) ? podSpec.containers : [];
      const initContainerList = Array.isArray(podSpec?.initContainers) ? podSpec.initContainers : [];
      const containers = [...containerList, ...initContainerList].filter(isRecord);
      const servicePorts = extractServicePorts(kind, spec);
      resources.push({
        kind,
        name,
        line: findYamlKindLine(lineLookup, kind, name),
        ports: Array.from(new Set([
          ...containers.flatMap(containerPorts),
          ...servicePorts.flatMap(port => [port.port, port.targetPort]).filter((value): value is string => Boolean(value)),
        ])),
        servicePorts,
        selector: extractSelector(kind, spec),
        labels: extractPodLabels(kind, metadata, spec),
        replicas: typeof spec.replicas === 'number' ? spec.replicas : undefined,
        images: containers.map(container => stringValue(container.image)).filter((value): value is string => Boolean(value)),
        serviceNames: extractServiceNames(kind, name, spec, metadata),
        env: extractContainerEnv(containers),
        ingressBackends: extractIngressBackends(spec),
        schedule: kind === 'CronJob' ? stringValue(spec.schedule) : undefined,
        command: extractContainerCommand(containers),
      });
    });
  } catch {
    return [];
  }
  return resources;
}

/** `command` + `args` of every container, concatenated into one evidence
 *  string (e.g. `bin/console app:cron:process --env=prod`) — the ground
 *  truth for linking a workload's container invocation to the console
 *  command / entry point it runs. Absent when neither is set. */
function extractContainerCommand(containers: Record<string, any>[]): string | undefined {
  const parts: string[] = [];
  for (const container of containers) {
    if (Array.isArray(container.command)) parts.push(...container.command.map(stringValue).filter((v): v is string => Boolean(v)));
    if (Array.isArray(container.args)) parts.push(...container.args.map(stringValue).filter((v): v is string => Boolean(v)));
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

const SUPPORTED_KUBERNETES_KINDS = new Set([
  'Deployment',
  'Service',
  'Ingress',
  'ConfigMap',
  'Secret',
  'StatefulSet',
  'DaemonSet',
  'CronJob',
  'Job',
  'HorizontalPodAutoscaler',
]);

function extractPodSpec(kind: string, spec: Record<string, any>): Record<string, any> | undefined {
  if (kind === 'CronJob') return spec.jobTemplate?.spec?.template?.spec;
  if (kind === 'Job') return spec.template?.spec;
  return spec.template?.spec;
}

function extractServicePorts(kind: string, spec: Record<string, any>): Array<{ port?: string; targetPort?: string; name?: string }> {
  if (kind !== 'Service' || !Array.isArray(spec.ports)) return [];
  return spec.ports.filter(isRecord).map(port => ({
    port: stringValue(port.port),
    targetPort: stringValue(port.targetPort),
    name: stringValue(port.name),
  }));
}

function extractSelector(kind: string, spec: Record<string, any>): Record<string, string> {
  if (kind === 'Service') return stringRecord(spec.selector);
  if (kind === 'HorizontalPodAutoscaler') return { target: stringValue(spec.scaleTargetRef?.name) || '' };
  return stringRecord(spec.selector?.matchLabels);
}

function extractPodLabels(kind: string, metadata: Record<string, any>, spec: Record<string, any>): Record<string, string> {
  if (['Deployment', 'StatefulSet', 'DaemonSet', 'Job'].includes(kind)) return stringRecord(spec.template?.metadata?.labels);
  if (kind === 'CronJob') return stringRecord(spec.jobTemplate?.spec?.template?.metadata?.labels);
  return stringRecord(metadata.labels);
}

function extractServiceNames(kind: string, name: string, spec: Record<string, any>, metadata: Record<string, any>): string[] {
  const aliases = new Set<string>([name]);
  for (const value of Object.values(stringRecord(metadata.labels))) aliases.add(value);
  for (const value of Object.values(extractSelector(kind, spec))) aliases.add(value);
  for (const backend of extractIngressBackends(spec)) aliases.add(backend.service);
  return Array.from(aliases).filter(Boolean);
}

function containerPorts(container: Record<string, any>): string[] {
  if (!Array.isArray(container.ports)) return [];
  return container.ports.filter(isRecord).map(port => stringValue(port.containerPort)).filter((value): value is string => Boolean(value));
}

function extractContainerEnv(containers: Record<string, any>[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const container of containers) {
    if (!Array.isArray(container.env)) continue;
    for (const entry of container.env.filter(isRecord)) {
      const name = stringValue(entry.name);
      if (!name) continue;
      env[name] = stringValue(entry.value) || stringValue(entry.valueFrom?.secretKeyRef?.name) || stringValue(entry.valueFrom?.configMapKeyRef?.name) || '';
    }
  }
  return env;
}

function extractIngressBackends(spec: Record<string, any>): Array<{ host?: string; path?: string; service: string; port?: string }> {
  const backends: Array<{ host?: string; path?: string; service: string; port?: string }> = [];
  const defaultService = serviceBackend(spec.defaultBackend);
  if (defaultService) backends.push(defaultService);
  if (!Array.isArray(spec.rules)) return backends;
  for (const rule of spec.rules.filter(isRecord)) {
    const host = stringValue(rule.host);
    const paths = Array.isArray(rule.http?.paths) ? rule.http.paths.filter(isRecord) : [];
    for (const item of paths) {
      const backend = serviceBackend(item.backend);
      if (backend) backends.push({ ...backend, host, path: stringValue(item.path) });
    }
  }
  return backends;
}

function serviceBackend(value: unknown): { service: string; port?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const service = isRecord(value.service) ? value.service : {};
  const name = stringValue(service.name) || stringValue((value as any).serviceName);
  if (!name) return undefined;
  return { service: name, port: stringValue((service.port as any)?.number) || stringValue((service.port as any)?.name) || stringValue((value as any).servicePort) };
}

function selectorMatchesLabels(selector: Record<string, string>, labels: Record<string, string>): boolean {
  return Object.entries(selector).every(([key, value]) => labels[key] === value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') out[key] = String(item);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeLoadYaml(content: string): unknown {
  try {
    return yaml.load(content);
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function findYamlKeyLine(lines: string[], key: string): number {
  const pattern = new RegExp(`^\\s{2}${escapeRegExp(key)}:\\s*`);
  const index = lines.findIndex(line => pattern.test(line));
  return index === -1 ? 1 : index + 1;
}

function findYamlKindLine(lines: string[], kind: string, name: string): number {
  const kindIndex = lines.findIndex(line => new RegExp(`^\\s*kind:\\s*${escapeRegExp(kind)}\\s*$`).test(line));
  if (kindIndex !== -1) return kindIndex + 1;
  const nameIndex = lines.findIndex(line => new RegExp(`^\\s*name:\\s*${escapeRegExp(name)}\\s*$`).test(line));
  return nameIndex === -1 ? 1 : nameIndex + 1;
}

function isHelmTemplatePath(relativeFile: string): boolean {
  const normalized = relativeFile.replace(/\\/g, '/');
  return /\/templates\/.*\.ya?ml$/.test(normalized) || /(^|\/)Chart\.ya?ml$/.test(normalized);
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

function lastValue(values: string[]): string | undefined {
  return values.length > 0 ? values[values.length - 1] : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inferServiceName(projectPath: string, relativeFile: string, command?: string): string {
  // Production analyze snapshots the source to an on-disk dir named after the
  // analysisId HASH, so path.basename(projectPath) can be hash-shaped rather
  // than a real service name. Prefer it when it's a legitimate name; when
  // it's hash/id-shaped, fall back to the Dockerfile's own containing
  // directory name (still real, just less specific), and only as a last
  // resort to a stable non-hash placeholder — never emit the hash.
  const projectBase = path.basename(projectPath);
  const dockerfileDir = path.basename(path.dirname(relativeFile));
  let base: string;
  // ORDER = evidence strength, and it must not be "whatever is cheapest to read".
  //
  // Measured 2026-08-10, reproduced in isolation: a production snapshot dir named
  // `prj_<id>` was ACCEPTED here as a legitimate name, because this function
  // tested `isHashOrIdShapedToken` (narrow: hex/UUID/no-vowel blobs) while
  // `safeDeployableName` downstream rejects with `isIdentifierShapedRepoBasename`
  // (broad: also `prj_`/`wsp_`-prefixed storage ids). Two functions disagreeing
  // about what an id looks like meant the storage id won rank 1, the real
  // evidence below was never consulted, and the downstream guard then replaced
  // the id with `unnamed-service` — publishing a nameless primary ship unit on a
  // 92,582-node repo while its own CMD named the app.
  //
  // Fixed two ways, both repo-agnostic:
  //  - ONE id-shape test (the broad one) everywhere, so no name can pass one
  //    check and fail the next;
  //  - the author's own DECLARATION (the run command) outranks a directory
  //    basename, because a directory name is an accident of how we stored the
  //    source while ENTRYPOINT/CMD is something the author wrote deliberately.
  //
  // REFINED 2026-08-11, measured: `CMD ["node", "server.js"]` in a directory
  // named `zerac-ui` shipped the alias `server`. The rank above is right about
  // WHY the declaration usually wins — the author wrote it — but wrong to treat
  // every declared token as equally identifying. `server`, `main`, `app`,
  // `index` name the CONVENTION for where a program starts, not which program
  // it is; they would be the alias for a huge fraction of all repos, which is
  // the definition of a name that identifies nothing. A real directory name
  // beats a conventional entry stem, and the stem is still kept as a secondary
  // alias so topology joins that match on it keep working.
  const declared = serviceNameFromCommand(command);
  const declaredIdentifies = declared && !isConventionalEntryStem(declared);
  if (declaredIdentifies) {
    base = declared!;
  } else if (dockerfileDir && dockerfileDir !== '.' && !isIdentifierShapedRepoBasename(dockerfileDir)) {
    base = dockerfileDir;
  } else if (projectBase && !isIdentifierShapedRepoBasename(projectBase)) {
    base = projectBase;
  } else if (declared) {
    // Every real directory name available is a storage id, so a conventional
    // entry stem — weak as it is — is still better evidence than a placeholder:
    // it at least came from something the author wrote.
    base = declared;
  } else {
    // Nothing the author declared is usable: no run command names a specific
    // binary, the Dockerfile sits at the root, and the only directory available
    // is the storage id. Stay honest rather than inventing something — the
    // caller's `safeDeployableName` publishes this placeholder, and the
    // deployable payload carries the boundary evidence that explains it.
    base = UNNAMED_SERVICE_PLACEHOLDER;
  }
  return base.replace(/[^a-zA-Z0-9_.-]/g, '-').toLowerCase();
}

/**
 * The ship unit's name as its own ENTRYPOINT/CMD declares it.
 *
 * Takes the first token that names something specific to THIS image, skipping
 * interpreters and shells (which name the runtime, not the service) and flags.
 * `["node", "gateway-app.mjs", "serve"]` yields `gateway-app`;
 * `["/usr/local/bin/cleanup-smoke"]` yields `cleanup-smoke`.
 * Returns undefined rather than guessing when nothing specific is present, so
 * the caller's placeholder still applies and no invented name ever ships.
 */
/**
 * Does this token name WHERE a program starts rather than WHICH program it is?
 *
 * `server`, `main`, `app`, `index` are the conventional entry-file stems of most
 * ecosystems. As a ship-unit alias they identify nothing — they would be the
 * name of an enormous share of all repos — so they must not outrank a real
 * directory name (see inferServiceName).
 *
 * spec-purity:vocab-ok — a closed ECOSYSTEM fact (conventional program-entry
 * filenames), in the same family as the GENERIC_RUNTIMES and TASK_RUNNERS
 * stoplists below. It only DEMOTES weak output; it never assigns a category and
 * cannot decide what a repo is or does.
 */
function isConventionalEntryStem(token: string): boolean {
  const CONVENTIONAL_ENTRY_STEMS = new Set([
    'server', 'serve', 'main', 'app', 'application', 'index', 'start', 'run',
    'bootstrap', 'entry', 'entrypoint', 'init', 'cli', 'bin', 'daemon',
    'worker', 'service', 'program',
  ]);
  return CONVENTIONAL_ENTRY_STEMS.has(token.trim().toLowerCase());
}

/**
 * Every alias this image can legitimately be joined on, PREFERRED FIRST.
 *
 * `service_aliases[0]` becomes the ship unit's published name (see
 * deployable-evidence/providers/container.ts), while the infra-topology linker
 * matches on any entry. Those two jobs pull in opposite directions — naming
 * wants the most identifying token, joining wants every token anyone might
 * reference — so this returns the ranked name first and keeps the rest instead
 * of discarding real evidence to satisfy the ranking.
 */
function inferServiceAliases(projectPath: string, relativeFile: string, command?: string): string[] {
  const normalize = (value: string): string => value.replace(/[^a-zA-Z0-9_.-]/g, '-').toLowerCase();
  const preferred = inferServiceName(projectPath, relativeFile, command);
  const candidates = [
    preferred,
    ...[serviceNameFromCommand(command), path.basename(path.dirname(relativeFile)), path.basename(projectPath)]
      .filter((value): value is string => Boolean(value) && value !== '.')
      .filter(value => !isIdentifierShapedRepoBasename(value))
      .map(normalize),
  ];
  return Array.from(new Set(candidates.filter(Boolean)));
}

function serviceNameFromCommand(command?: string): string | undefined {
  if (!command) return undefined;
  // Tolerates both exec-form JSON (["node","app.js"]) and shell form.
  const tokens = command
    .replace(/[[\]",]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(token => !token.startsWith('-'));
  // A TASK RUNNER's arguments are script/target names, not binaries: `npm start`
  // declares the script "start", `rake deploy` the task "deploy". Taking the
  // next token there produced the ship-unit name "start" — junk, and worse than
  // the directory name it displaced. So when argv[0] is a task runner, this
  // command declares NO binary and we must fall through to the next rank.
  //
  // spec-purity:vocab-ok — closed ECOSYSTEM fact (task runners), not a
  // business/domain bag; it only suppresses bad output and can never categorise
  // a repo.
  const TASK_RUNNERS = new Set([
    'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'deno',
    'make', 'rake', 'mix', 'poetry', 'uv', 'pipenv', 'hatch', 'tox',
    'gradle', 'gradlew', 'mvn', 'sbt', 'cargo', 'composer', 'bundle', 'go',
  ]);
  // Runtimes/shells name the interpreter, not the deployable.
  //
  // spec-purity:vocab-ok — this is a closed ECOSYSTEM fact (the set of language
  // runtimes, package managers and init shims that can appear as argv[0]), not a
  // business/domain keyword bag, and it REJECTS bad output rather than assigning
  // a category. Nothing here decides what a repo is or does; it only prevents
  // naming a ship unit "node" or "sh". The cardinal rule bans hardcoded
  // brand/domain categorizers — a stoplist over another ecosystem's own
  // vocabulary is the opposite: it keeps that vocabulary OUT of our output.
  const GENERIC_RUNTIMES = new Set([
    'sh', 'bash', 'zsh', 'ash', 'dash', 'env', 'exec',
    'node', 'nodejs', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno',
    'python', 'python3', 'py', 'pip', 'uv', 'ruby', 'bundle', 'rake',
    'java', 'dotnet', 'go', 'php', 'perl', 'gunicorn', 'uvicorn', 'supervisord',
    'tini', 'dumb-init', 'entrypoint.sh', 'docker-entrypoint.sh', 'start.sh',
  ]);
  const leader = tokens.length ? path.basename(tokens[0]).toLowerCase() : '';
  if (TASK_RUNNERS.has(leader)) return undefined;
  for (const token of tokens) {
    const basename = path.basename(token);
    const withoutExtension = basename.replace(/\.(mjs|cjs|js|ts|py|rb|sh|jar|exe)$/i, '');
    if (!withoutExtension) continue;
    if (GENERIC_RUNTIMES.has(basename.toLowerCase()) || GENERIC_RUNTIMES.has(withoutExtension.toLowerCase())) continue;
    if (isIdentifierShapedRepoBasename(withoutExtension)) continue;
    return withoutExtension;
  }
  return undefined;
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
