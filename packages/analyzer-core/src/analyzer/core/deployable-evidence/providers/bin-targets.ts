import * as fs from 'fs-extra';
import * as path from 'path';
import type { CASEntryPoint, DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { IGNORE_GLOBS, safeGlobSync } from '../util';

/** Cargo [[bin]] targets, package.json bin field, go main packages, src/bin/* files. */
function collectBinTargets(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath } = ctx;
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

function extractPortFromEntryPoint(entry: CASEntryPoint): number | undefined {
  const p = entry.trigger?.path || '';
  const match = p.match(/:(\d{2,5})\b/);
  return match ? Number(match[1]) : undefined;
}

/** Server-bootstrap / port-binding entry points already flagged by framework analyzers as CASEntryPoint type === 'http'. */
function collectServerEntries(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const out: DeployableEvidence[] = [];
  const seen = new Set<string>();
  const entryPoints = (ctx.cas.entry_points || []) as CASEntryPoint[];

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

function collect(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  return [...collectBinTargets(ctx), ...collectServerEntries(ctx)];
}

export const binTargetsProvider: EvidenceProvider = {
  id: 'bin-targets',
  tier: 2,
  collect,
};
