import * as fs from 'fs-extra';
import * as path from 'path';
import type { CASEntryPoint, CASNode, DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { IGNORE_GLOBS, isGenericStructuralDirName, safeDeployableName, safeGlobSync } from '../util';


function collectBinTargets(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
  const out: DeployableEvidence[] = [];


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
    if (json.bin) {
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










    const engines = json.engines && typeof json.engines === 'object' ? json.engines : undefined;
    const vscodeEngineRange = typeof engines?.vscode === 'string' ? engines.vscode : undefined;
    const vscodeEntry = typeof json.main === 'string' ? json.main : (typeof json.browser === 'string' ? json.browser : undefined);
    if (vscodeEngineRange && vscodeEntry) {
      out.push({
        root_path: path.dirname(manifest),
        name: json.name || safeDeployableName(displayName || path.basename(path.dirname(manifest))),
        tier: 2,
        kind: 'bin',
        evidence: [
          `VS Code extension: engines.vscode="${vscodeEngineRange}", entry ${vscodeEntry} (${manifest})`,
          ...(Array.isArray(json.activationEvents) && json.activationEvents.length
            ? [`activationEvents: ${json.activationEvents.slice(0, 5).join(', ')}`]
            : []),
        ],
      });
    }








    const deps = { ...(json.dependencies || {}), ...(json.devDependencies || {}) };
    const hasElectronDependency = Boolean(deps.electron);
    const hasElectronPackagingConfig = Boolean(json.build) || Boolean(deps['electron-builder']) ||
      Object.keys(deps).some(dep => dep.startsWith('@electron-forge/'));
    if (typeof json.main === 'string' && hasElectronDependency && !hasElectronPackagingConfig) {
      out.push({
        root_path: path.dirname(manifest),
        name: json.name || safeDeployableName(displayName || path.basename(path.dirname(manifest))),
        tier: 2,
        kind: 'bin',
        evidence: [`Electron app entry: main="${json.main}", electron in dependencies (${manifest})`],
      });
    }
  }


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
      name: path.basename(dir) === '.' ? safeDeployableName(displayName || path.basename(projectPath)) : path.basename(dir),
      tier: 2,
      kind: 'bin',
      evidence: [`package main entry: ${goFile}`],
    });
  }


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

















function resolveHandlerFile(entry: CASEntryPoint, nodesById: Map<string, CASNode>): string | undefined {
  const handlerFile = entry.handler?.file;
  const nodeId = entry.handler?.node_id || entry.source_node;
  const node = nodeId ? nodesById.get(nodeId) : undefined;
  const nodeFile = node?.source?.file;

  if (!nodeFile) return handlerFile;
  if (!handlerFile) return nodeFile;
  if (nodeFile === handlerFile) return handlerFile;



  if (nodeFile.endsWith(`/${handlerFile}`)) return nodeFile;
  return handlerFile;
}

function extractPortFromEntryPoint(entry: CASEntryPoint): number | undefined {
  const p = entry.trigger?.path || '';
  const match = p.match(/:(\d{2,5})\b/);
  return match ? Number(match[1]) : undefined;
}






const APP_PARENT_SEGMENTS = new Set(['apps', 'services', 'packages', 'libs', 'crates', 'cmd']);








const ROUTE_ROOT_SEGMENTS = new Set([
  'routes', 'route', 'pages', 'handlers', 'handler',
  'controllers', 'controller', 'endpoints', 'endpoint', 'views', 'resolvers',
]);















function serverEntryRoot(handlerFile: string): string {
  const dir = path.dirname(handlerFile).replace(/\\/g, '/').replace(/\/+$/, '');
  if (!dir || dir === '.') return dir || '.';
  const parts = dir.split('/');
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i].toLowerCase();
    if (APP_PARENT_SEGMENTS.has(seg)) {

      i += 1;
      continue;
    }




    if (ROUTE_ROOT_SEGMENTS.has(seg) || seg === 'app' || seg === 'pages') {
      return parts.slice(0, i).join('/') || '.';
    }
  }
  return dir;
}

















function collectServerEntries(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { displayName, projectPath } = ctx;
  const byRoot = new Map<string, DeployableEvidence>();
  const entryPoints = (ctx.cas.entry_points || []) as CASEntryPoint[];
  const nodesById = new Map<string, CASNode>((ctx.nodes || []).map(n => [n.id, n]));












  const rootName = (rootPath: string): string => {
    if (rootPath === '' || rootPath === '.') {
      return safeDeployableName(displayName || path.basename(projectPath));
    }
    const segments = rootPath.split('/').filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      if (!isGenericStructuralDirName(segments[i])) {
        return safeDeployableName(segments[i]);
      }
    }
    return safeDeployableName(displayName || path.basename(projectPath));
  };

  for (const entry of entryPoints) {
    if (entry.type !== 'http') continue;
    const handlerFile = resolveHandlerFile(entry, nodesById);
    if (!handlerFile) continue;
    const rootPath = serverEntryRoot(handlerFile);

    const port = extractPortFromEntryPoint(entry);
    const routeEvidence = entry.trigger?.path
      ? `route: ${entry.trigger.method || 'ALL'} ${entry.trigger.path}`
      : undefined;

    const existing = byRoot.get(rootPath);
    if (!existing) {
      byRoot.set(rootPath, {
        root_path: rootPath,


        name: rootName(rootPath),
        tier: 2,
        kind: 'server-entry',
        evidence: [
          `HTTP entry point: ${entry.name} (${handlerFile}${entry.handler?.line ? `:${entry.handler.line}` : ''})`,
          ...(routeEvidence ? [routeEvidence] : []),
        ],
        ports: port ? [port] : undefined,
      });
      continue;
    }



    if (routeEvidence && !existing.evidence.includes(routeEvidence) && existing.evidence.length < 10) {
      existing.evidence.push(routeEvidence);
    }
    if (port && !(existing.ports || []).includes(port)) {
      existing.ports = [...(existing.ports || []), port];
    }
  }

  return [...byRoot.values()];
}

function collect(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  return [...collectBinTargets(ctx), ...collectServerEntries(ctx)];
}

export const binTargetsProvider: EvidenceProvider = {
  id: 'bin-targets',
  tier: 2,
  collect,
};
