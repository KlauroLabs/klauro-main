import * as fs from 'fs-extra';
import * as path from 'path';
import { globSync as importedGlobSync } from 'glob';
import type { CASEntryPoint, CASExitPoint, CASNode, DeployableEvidence } from '../../types/cas.types';

/**
 * Defensive glob resolution: under some CJS/ESM interop configurations (seen
 * under ts-jest) the named `globSync` import is not callable even though the
 * `glob` module exports it at runtime. Mirrors orchestrator.ts's
 * safeGlobSync fallback (require('glob').globSync / .sync).
 */
function safeGlobSync(pattern: string | string[], options: Record<string, any>): string[] {
  try {
    if (typeof importedGlobSync === 'function') return importedGlobSync(pattern as any, options as any);
  } catch {
    // fall through to require-based resolution
  }
  try {
    const globModule = require('glob');
    const sync = globModule.globSync || globModule.sync;
    return typeof sync === 'function' ? sync(pattern as any, options as any) : [];
  } catch {
    return [];
  }
}

/**
 * Deployable Evidence Collector
 *
 * Composes a per-artifact "what can actually be deployed/run/shipped" fact
 * list from evidence ALREADY extracted by other analyzers (container topology,
 * distribution artifacts) plus a small amount of direct manifest/CI reading
 * that no existing analyzer covers. It does not re-parse Dockerfiles, compose
 * files, or k8s manifests — it reads the CASNode/CASEntryPoint/CASExitPoint
 * metadata those analyzers already produced.
 *
 * Tiers:
 *  1. ship declaration    - Dockerfiles, compose services, k8s manifests,
 *                           installers/desktop-entries/service-units, CI
 *                           deploy jobs. These declare "this gets shipped".
 *  2. runnable entry      - bin targets (Cargo [[bin]], package.json bin,
 *                           go main packages, src/bin/*) and server-bootstrap
 *                           / port-binding entry points already flagged by the
 *                           framework analyzers (CASEntryPoint type === 'http').
 *  3. package identity    - package.json / Cargo.toml / go.mod as the
 *                           publishable/installable unit identity.
 *
 * Consumed downstream via CASOutput.deployable_evidence (see cas.types.ts).
 */

const IGNORE_GLOBS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/target/**',
  '**/.klauro*/**',
  '**/vendor/**',
];

export interface CollectDeployableEvidenceInput {
  projectPath: string;
  nodes: CASNode[];
  entryPoints: CASEntryPoint[];
  exitPoints: CASExitPoint[];
}

export function collectDeployableEvidence(input: CollectDeployableEvidenceInput): DeployableEvidence[] {
  const { projectPath, nodes, entryPoints, exitPoints } = input;
  const results: DeployableEvidence[] = [];

  results.push(...collectTier1FromContainerTopologyNodes(nodes, exitPoints));
  results.push(...collectTier1FromDistributionArtifactNodes(nodes));
  results.push(...collectTier1FromCiDeployJobs(projectPath));
  results.push(...collectTier2BinTargets(projectPath));
  results.push(...collectTier2ServerEntries(entryPoints));
  results.push(...collectTier3PackageIdentity(projectPath));

  return dedupe(results);
}

// ---------------------------------------------------------------------------
// Tier 1: ship declarations
// ---------------------------------------------------------------------------

/** Dockerfiles (container_image_definition nodes) + compose services (compose_service nodes). */
function collectTier1FromContainerTopologyNodes(nodes: CASNode[], exitPoints: CASExitPoint[]): DeployableEvidence[] {
  const out: DeployableEvidence[] = [];

  for (const node of nodes) {
    if (node.type === 'container_image_definition') {
      const metadata = (node.metadata || {}) as Record<string, any>;
      const file = node.source?.file || '';
      const evidence: string[] = [`Dockerfile: ${file}`];
      const baseImages: string[] = arrayOf(metadata.base_images);
      if (baseImages.length) evidence.push(`FROM ${baseImages.join(', ')}`);
      if (metadata.command) evidence.push(`entrypoint/cmd: ${metadata.command}`);
      const exposedPorts: string[] = arrayOf(metadata.exposed_ports);
      if (exposedPorts.length) evidence.push(`EXPOSE ${exposedPorts.join(', ')}`);

      out.push({
        root_path: path.dirname(file) || '.',
        name: node.name || file,
        tier: 1,
        kind: 'container',
        evidence,
        // What this Dockerfile packages: the base image lineage is the closest
        // deterministic membership signal available without re-parsing COPY
        // instructions (not extracted by container-topology-analyzer today).
        ships_paths: baseImages,
        ports: numericPorts(exposedPorts),
      });
    }

    if (node.type === 'compose_service') {
      const metadata = (node.metadata || {}) as Record<string, any>;
      const file = node.source?.file || '';
      const evidence: string[] = [`compose service: ${metadata.deployment_service_name || node.name} (${file})`];
      if (metadata.image) evidence.push(`image: ${metadata.image}`);
      if (metadata.build) evidence.push(`build: ${metadata.build}`);
      const ports: Array<{ host?: string; container: string }> = Array.isArray(metadata.ports) ? metadata.ports : [];
      if (ports.length) evidence.push(`ports: ${ports.map(formatPort).join(', ')}`);

      out.push({
        root_path: metadata.build ? String(metadata.build) : path.dirname(file) || '.',
        name: String(metadata.deployment_service_name || node.name),
        tier: 1,
        kind: 'compose-service',
        evidence,
        ports: numericPorts(ports.map(p => p.container)),
      });
    }

    if (typeof node.type === 'string' && node.type.startsWith('kubernetes_')) {
      const metadata = (node.metadata || {}) as Record<string, any>;
      const file = node.source?.file || '';
      const evidence: string[] = [`kubernetes ${metadata.kubernetes_kind || node.type}: ${metadata.deployment_service_name || node.name} (${file})`];
      const images: string[] = arrayOf(metadata.images);
      if (images.length) evidence.push(`images: ${images.join(', ')}`);
      const ports: string[] = arrayOf(metadata.ports);
      if (ports.length) evidence.push(`ports: ${ports.join(', ')}`);

      out.push({
        root_path: path.dirname(file) || '.',
        name: String(metadata.deployment_service_name || node.name),
        tier: 1,
        kind: 'k8s',
        evidence,
        ships_paths: images,
        ports: numericPorts(ports),
      });
    }
  }

  // External service exit points recorded by the compose analyzer (image-only
  // services with no own build) are dependencies, not ship-declarations of
  // this workspace — intentionally excluded here.
  void exitPoints;

  return out;
}

/** Installers, desktop entries, service units, install/release scripts (distribution-artifact-analyzer output). */
function collectTier1FromDistributionArtifactNodes(nodes: CASNode[]): DeployableEvidence[] {
  const out: DeployableEvidence[] = [];

  for (const node of nodes) {
    const metadata = (node.metadata || {}) as Record<string, any>;
    const artifactKind = String(metadata.artifact_kind || '');
    if (!artifactKind || metadata.topology_surface !== 'distribution-artifacts') continue;

    const file = node.source?.file || '';
    const binaryNames: string[] = arrayOf(metadata.binary_names);
    const evidence: string[] = [`${artifactKind}: ${file}`];
    if (metadata.distribution_role) evidence.push(`role: ${metadata.distribution_role}`);
    if (binaryNames.length) evidence.push(`binaries: ${binaryNames.join(', ')}`);
    const installPaths: string[] = arrayOf(metadata.install_paths);
    if (installPaths.length) evidence.push(`install paths: ${installPaths.join(', ')}`);

    out.push({
      root_path: path.dirname(file) || '.',
      name: String(metadata.product_name || node.name),
      tier: 1,
      kind: artifactKind === 'installer' ? 'installer' : 'installer',
      evidence,
      ships_paths: binaryNames,
    });
  }

  return out;
}

/** CI workflow jobs whose steps deploy/publish/release (no existing analyzer covers this). */
function collectTier1FromCiDeployJobs(projectPath: string): DeployableEvidence[] {
  const out: DeployableEvidence[] = [];
  let files: string[] = [];
  try {
    files = safeGlobSync(['.github/workflows/*.yml', '.github/workflows/*.yaml'], {
      cwd: projectPath,
      ignore: IGNORE_GLOBS,
      nodir: true,
      absolute: false,
    });
  } catch {
    return out;
  }

  const deployMarker = /\b(deploy|publish|release|docker\/build-push-action|helm upgrade|kubectl apply|serverless deploy|sam deploy|cdk deploy|terraform apply|npm publish|cargo publish|gh release|actions\/deploy-pages)\b/i;

  for (const relativeFile of files) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(projectPath, relativeFile), 'utf8');
    } catch {
      continue;
    }
    if (!deployMarker.test(content)) continue;

    const jobNames = /^jobs:\s*$/m.test(content)
      ? [...content.matchAll(/^\s{2}([A-Za-z0-9_-]+):\s*$/gm)].map(m => m[1])
      : [];
    const matchedLine = content.split(/\r?\n/).findIndex(line => deployMarker.test(line));

    out.push({
      root_path: path.dirname(relativeFile),
      name: path.basename(relativeFile, path.extname(relativeFile)),
      tier: 1,
      kind: 'ci-deploy',
      evidence: [
        `CI workflow: ${relativeFile}`,
        ...(jobNames.length ? [`jobs: ${jobNames.slice(0, 10).join(', ')}`] : []),
        `deploy marker at line ${matchedLine >= 0 ? matchedLine + 1 : '?'}`,
      ],
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Tier 2: runnable entries
// ---------------------------------------------------------------------------

/** Cargo [[bin]] targets, package.json bin field, go main packages, src/bin/* files. */
function collectTier2BinTargets(projectPath: string): DeployableEvidence[] {
  const out: DeployableEvidence[] = [];

  // Cargo [[bin]]
  let cargoManifests: string[] = [];
  try {
    cargoManifests = safeGlobSync('**/Cargo.toml', { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    cargoManifests = [];
  }
  for (const manifest of cargoManifests) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(projectPath, manifest), 'utf8');
    } catch {
      continue;
    }
    const binMatches = [...content.matchAll(/\[\[bin\]\]\s*\n(?:[^\n[]*\n)*?\s*name\s*=\s*"([^"]+)"/g)];
    for (const match of binMatches) {
      out.push({
        root_path: path.dirname(manifest),
        name: match[1],
        tier: 2,
        kind: 'bin',
        evidence: [`Cargo.toml [[bin]] name = "${match[1]}" (${manifest})`],
      });
    }
    if (!binMatches.length && fs.existsSync(path.join(projectPath, path.dirname(manifest), 'src', 'main.rs'))) {
      const packageName = content.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
      out.push({
        root_path: path.dirname(manifest),
        name: packageName || path.basename(path.dirname(manifest)),
        tier: 2,
        kind: 'bin',
        evidence: [`src/main.rs present, no [[bin]] override (${path.join(path.dirname(manifest), 'src', 'main.rs')})`],
      });
    }
  }

  // package.json bin field
  let packageManifests: string[] = [];
  try {
    packageManifests = safeGlobSync('**/package.json', { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    packageManifests = [];
  }
  for (const manifest of packageManifests) {
    let json: any;
    try {
      json = fs.readJsonSync(path.join(projectPath, manifest));
    } catch {
      continue;
    }
    if (!json.bin) continue;
    const binEntries = typeof json.bin === 'string' ? { [json.name || path.basename(path.dirname(manifest))]: json.bin } : json.bin;
    for (const [binName, binPath] of Object.entries(binEntries)) {
      out.push({
        root_path: path.dirname(manifest),
        name: binName,
        tier: 2,
        kind: 'bin',
        evidence: [`package.json bin["${binName}"] = "${binPath}" (${manifest})`],
      });
    }
  }

  // go main packages
  let goFiles: string[] = [];
  try {
    goFiles = safeGlobSync(['**/main.go', 'cmd/**/*.go'], { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    goFiles = [];
  }
  const seenGoDirs = new Set<string>();
  for (const goFile of goFiles) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(projectPath, goFile), 'utf8');
    } catch {
      continue;
    }
    if (!/^package\s+main\b/m.test(content)) continue;
    const dir = path.dirname(goFile);
    if (seenGoDirs.has(dir)) continue;
    seenGoDirs.add(dir);
    out.push({
      root_path: dir,
      name: path.basename(dir) === '.' ? path.basename(projectPath) : path.basename(dir),
      tier: 2,
      kind: 'bin',
      evidence: [`package main entry: ${goFile}`],
    });
  }

  // src/bin/*.{ts,js,rs,py} (generic scripting-language bin convention)
  let srcBinFiles: string[] = [];
  try {
    srcBinFiles = safeGlobSync('**/src/bin/*.{ts,js,rs,py}', { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    srcBinFiles = [];
  }
  for (const file of srcBinFiles) {
    out.push({
      root_path: path.dirname(path.dirname(file)),
      name: path.basename(file, path.extname(file)),
      tier: 2,
      kind: 'bin',
      evidence: [`src/bin entry: ${file}`],
    });
  }

  return out;
}

/** Server-bootstrap / port-binding entry points already flagged by framework analyzers as CASEntryPoint type === 'http'. */
function collectTier2ServerEntries(entryPoints: CASEntryPoint[]): DeployableEvidence[] {
  const out: DeployableEvidence[] = [];
  const seen = new Set<string>();

  for (const entry of entryPoints) {
    if (entry.type !== 'http') continue;
    const handlerFile = entry.handler?.file;
    if (!handlerFile) continue;
    const rootPath = path.dirname(handlerFile);
    const dedupeKey = `${rootPath}::${entry.trigger?.path || entry.name}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const port = extractPortFromEntryPoint(entry);
    out.push({
      root_path: rootPath,
      name: entry.name || handlerFile,
      tier: 2,
      kind: 'server-entry',
      evidence: [
        `HTTP entry point: ${entry.name} (${handlerFile}${entry.handler?.line ? `:${entry.handler.line}` : ''})`,
        ...(entry.trigger?.path ? [`route: ${entry.trigger.method || 'ALL'} ${entry.trigger.path}`] : []),
      ],
      ports: port ? [port] : undefined,
    });
  }

  return out;
}

function extractPortFromEntryPoint(entry: CASEntryPoint): number | undefined {
  const path = entry.trigger?.path || '';
  const match = path.match(/:(\d{2,5})\b/);
  return match ? Number(match[1]) : undefined;
}

// ---------------------------------------------------------------------------
// Tier 3: package identity
// ---------------------------------------------------------------------------

function collectTier3PackageIdentity(projectPath: string): DeployableEvidence[] {
  const out: DeployableEvidence[] = [];

  const packageJsonPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const json = fs.readJsonSync(packageJsonPath);
      out.push({
        root_path: '.',
        name: json.name || path.basename(projectPath),
        tier: 3,
        kind: 'package',
        evidence: [
          `package.json name: ${json.name || '(unnamed)'}`,
          ...(json.version ? [`version: ${json.version}`] : []),
          ...(json.private ? ['private: true'] : []),
        ],
      });
    } catch {
      // unreadable manifest contributes nothing
    }
  }

  const cargoTomlPath = path.join(projectPath, 'Cargo.toml');
  if (fs.existsSync(cargoTomlPath)) {
    try {
      const content = fs.readFileSync(cargoTomlPath, 'utf8');
      const name = content.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
      const version = content.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
      if (name) {
        out.push({
          root_path: '.',
          name,
          tier: 3,
          kind: 'package',
          evidence: [`Cargo.toml name: ${name}`, ...(version ? [`version: ${version}`] : [])],
        });
      }
    } catch {
      // unreadable manifest contributes nothing
    }
  }

  const goModPath = path.join(projectPath, 'go.mod');
  if (fs.existsSync(goModPath)) {
    try {
      const content = fs.readFileSync(goModPath, 'utf8');
      const module = content.match(/^module\s+(\S+)/m)?.[1];
      if (module) {
        out.push({
          root_path: '.',
          name: module,
          tier: 3,
          kind: 'package',
          evidence: [`go.mod module: ${module}`],
        });
      }
    } catch {
      // unreadable manifest contributes nothing
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function arrayOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
}

function numericPorts(values: string[]): number[] | undefined {
  const ports = values
    .map(v => Number(String(v).replace(/\/tcp$|\/udp$/i, '').trim()))
    .filter(n => Number.isFinite(n) && n > 0 && n < 65536);
  return ports.length ? [...new Set(ports)] : undefined;
}

function formatPort(port: { host?: string; container: string }): string {
  return port.host ? `${port.host}:${port.container}` : port.container;
}

function dedupe(items: DeployableEvidence[]): DeployableEvidence[] {
  const seen = new Set<string>();
  const out: DeployableEvidence[] = [];
  for (const item of items) {
    const key = `${item.tier}::${item.kind}::${item.root_path}::${item.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
