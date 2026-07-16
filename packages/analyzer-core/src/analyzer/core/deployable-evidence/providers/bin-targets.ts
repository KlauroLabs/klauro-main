import * as fs from 'fs-extra';
import * as path from 'path';
import type { CASEntryPoint, CASNode, DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { IGNORE_GLOBS, safeDeployableName, safeGlobSync } from '../util';

/** Cargo [[bin]] targets, package.json bin field, go main packages, src/bin/* files. */
function collectBinTargets(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
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
      name: path.basename(dir) === '.' ? safeDeployableName(displayName || path.basename(projectPath)) : path.basename(dir),
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

/**
 * Resolve the best repo-relative file path for an entry point's handler.
 *
 * `entry.handler.file` is sometimes recorded relative to the sub-package/app
 * scan root that produced it rather than the full monorepo-relative path
 * (e.g. `src/routes/auth.ts` instead of `packages/analyzer-core/src/routes/auth.ts`)
 * — observed when a per-package analysis pass gets merged into a wider
 * workspace CAS: the corresponding `CASNode.source.file` for the SAME
 * handler carries the correctly-prefixed path (that field gets rewritten
 * during the merge; `entry_points[].handler.file` does not). Rather than
 * hardcode any app/package name, cross-check against the node graph already
 * on `ctx` and prefer the node's path when it is a proper superset of the
 * handler's recorded file — i.e. it disagrees only by a missing prefix, not
 * by pointing somewhere unrelated. Falls back to `entry.handler.file`
 * whenever no corroborating node is found or the two paths fully agree.
 */
function resolveHandlerFile(entry: CASEntryPoint, nodesById: Map<string, CASNode>): string | undefined {
  const handlerFile = entry.handler?.file;
  const nodeId = entry.handler?.node_id || entry.source_node;
  const node = nodeId ? nodesById.get(nodeId) : undefined;
  const nodeFile = node?.source?.file;

  if (!nodeFile) return handlerFile;
  if (!handlerFile) return nodeFile;
  if (nodeFile === handlerFile) return handlerFile;
  // Only trust the node's file as a correction when it is a path-segment
  // superset of the handler's file (ends with "/<handlerFile>") — this is
  // the specific "missing prefix" shape, not an unrelated disagreement.
  if (nodeFile.endsWith(`/${handlerFile}`)) return nodeFile;
  return handlerFile;
}

function extractPortFromEntryPoint(entry: CASEntryPoint): number | undefined {
  const p = entry.trigger?.path || '';
  const match = p.match(/:(\d{2,5})\b/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Monorepo app-parent segments. The segment IMMEDIATELY after one of these is a
 * named ship unit (`apps/api`, `services/orders`) — never a route container —
 * so we must not collapse into it.
 */
const APP_PARENT_SEGMENTS = new Set(['apps', 'services', 'packages', 'libs', 'crates', 'cmd']);

/**
 * Framework route-root segments: the directory under which a file-per-route
 * layout hangs (`app/api/users/route.ts`, `pages/api/*`, a `routes/` or
 * `controllers/` tree). Everything at/below such a segment is per-route
 * structure, not the ship root — collapse to the directory just above it so all
 * of one server's routes fold into a single server-entry.
 */
const ROUTE_ROOT_SEGMENTS = new Set([
  'routes', 'route', 'pages', 'handlers', 'handler',
  'controllers', 'controller', 'endpoints', 'endpoint', 'views', 'resolvers',
]);

/**
 * Collapse a per-route handler dirname to its owning app/ship root.
 *
 * In file-per-route layouts the handler's OWN `path.dirname()` is a per-route
 * sub-directory (dir named after the route, e.g. `.../users`), so deduping HTTP
 * entries by raw dirname fragments one server into dozens of "deployables". Walk
 * segments left→right:
 *  - An app-parent segment (`apps/`, `services/`, …) protects the next segment
 *    as a named ship unit; keep everything through it and stop descending.
 *  - A route-root segment (`routes/`, `pages/`, `app/`+`api` next, …) marks the
 *    start of per-route structure; the ship root is everything BEFORE it.
 * `apps/api/src/server.ts` -> `apps/api/src` (app-parent protects `api`), while
 * `app/api/users/route.ts` -> `app`'s parent (here `.`), collapsing all routes.
 */
function serverEntryRoot(handlerFile: string): string {
  const dir = path.dirname(handlerFile).replace(/\\/g, '/').replace(/\/+$/, '');
  if (!dir || dir === '.') return dir || '.';
  const parts = dir.split('/');
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i].toLowerCase();
    if (APP_PARENT_SEGMENTS.has(seg)) {
      // Skip the app-parent AND the named app under it; resume scanning inside.
      i += 1;
      continue;
    }
    // A top-of-tree `app`/`pages` route root (Next.js app-router / pages-router):
    // treat `app` as a route root only when it is NOT a named app under an
    // app-parent (that case already `continue`d above). The ship root is the
    // directory above this route-root segment.
    if (ROUTE_ROOT_SEGMENTS.has(seg) || seg === 'app' || seg === 'pages') {
      return parts.slice(0, i).join('/') || '.';
    }
  }
  return dir;
}

/**
 * Server-bootstrap / port-binding entry points already flagged by framework
 * analyzers as CASEntryPoint type === 'http'.
 *
 * A single running server process can expose hundreds of HTTP routes, but it
 * is still ONE deployable — the process that binds the port, not each route
 * handler. Two defects this fold guards against:
 *  - Dedupe by the app/ship root (see serverEntryRoot), not the raw handler
 *    dirname, so a file-per-route layout (`app/api/users/route.ts`, …) doesn't
 *    fragment into one pseudo-deployable per route dir.
 *  - Name the deployable after the ship root, NEVER after a route path. The
 *    entry's `name` is a route label like `GET /api/users/:id`; using it as the
 *    deployable name (as the old `entry.name || handlerFile` did) leaked an
 *    HTTP path into `.name`, breaking every consumer that maps file→deployable
 *    by name. The route path belongs in `evidence`, not the name.
 */
function collectServerEntries(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { displayName, projectPath } = ctx;
  const byRoot = new Map<string, DeployableEvidence>();
  const entryPoints = (ctx.cas.entry_points || []) as CASEntryPoint[];
  const nodesById = new Map<string, CASNode>((ctx.nodes || []).map(n => [n.id, n]));

  const rootName = (rootPath: string): string =>
    rootPath === '' || rootPath === '.'
      ? safeDeployableName(displayName || path.basename(projectPath))
      : safeDeployableName(path.basename(rootPath));

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
        // Ship-root name, not the route path. entry.name (e.g. "GET /users")
        // is recorded as evidence below instead.
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

    // Same app root, another route: fold in as additional evidence/ports
    // rather than a new deployable.
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
