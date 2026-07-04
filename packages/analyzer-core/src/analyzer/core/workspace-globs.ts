import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';

/**
 * Discovers workspace-member package roots declared by glob patterns in
 * `pnpm-workspace.yaml`, root `package.json#workspaces`, `turbo.json`, or
 * `nx.json` — even when a member directory has NO `package.json` of its own
 * (deps hoisted to the workspace root, a real shape in pnpm/turbo/nx repos).
 *
 * `discoverProjectRoots` in orchestrator.ts otherwise only finds roots by
 * walking for package-boundary manifest files (`isPackageBoundaryManifest`),
 * so a member declared purely via a workspace glob — with no manifest of its
 * own — is invisible to it and never gets analyzed as (or scoped into) a
 * root. This is EVIDENCE-BASED: a directory only counts as a member if a
 * workspace manifest glob actually matches it. We never guess membership
 * from folder naming conventions alone (e.g. a bare `apps/` directory isn't
 * assumed to be a workspace just because it exists).
 *
 * Deliberately narrow: this only fills the "member dir lacks its own
 * package.json" gap. Directories that already have a package.json are
 * already found by `discoverProjectRoots`'s manifest walk — the caller must
 * dedupe against that set (a dir being both a glob member AND owning a
 * package.json must not be double-counted). A Dockerfile-only directory not
 * matched by any workspace glob is still not a boundary — this module never
 * treats deploy/build tooling as membership evidence, only workspace-manifest
 * globs are.
 */

const MAX_GLOB_MEMBERS = 500; // guard against runaway globs (e.g. '**' from a malformed manifest)

/** Reads and parses a YAML-ish `packages:` list from pnpm-workspace.yaml without a YAML dependency. */
function parsePnpmWorkspaceYaml(content: string): string[] {
  const patterns: string[] = [];
  const lines = content.split(/\r?\n/);
  let inPackages = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '');
    if (/^\s*packages\s*:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const itemMatch = line.match(/^\s*-\s*(.+?)\s*$/);
      if (itemMatch) {
        const value = itemMatch[1].trim().replace(/^['"]|['"]$/g, '');
        if (value) patterns.push(value);
        continue;
      }
      // A non-list, non-blank line ends the packages block.
      if (line.trim() !== '') inPackages = false;
    }
  }
  return patterns;
}

function readJsonSafe(filePath: string): any {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Collects the raw glob patterns declared by every workspace manifest we
 * recognize at the repo root. Patterns are collected verbatim (e.g.
 * `apps/*`, `packages/*`) — negations (`!foo`) are dropped since we only need
 * positive membership evidence here, not exact pnpm/npm resolution semantics.
 */
export function collectWorkspaceGlobPatterns(projectPath: string): string[] {
  const patterns: string[] = [];

  // pnpm-workspace.yaml: packages: [ - 'apps/*', ... ]
  const pnpmWorkspacePath = path.join(projectPath, 'pnpm-workspace.yaml');
  try {
    if (fs.existsSync(pnpmWorkspacePath)) {
      const content = fs.readFileSync(pnpmWorkspacePath, 'utf8');
      patterns.push(...parsePnpmWorkspaceYaml(content));
    }
  } catch {
    // best-effort: malformed yaml just yields no patterns from this source
  }

  // root package.json#workspaces: either a bare array or { packages: [...] } (yarn/npm)
  const rootPackageJson = readJsonSafe(path.join(projectPath, 'package.json'));
  if (rootPackageJson && rootPackageJson.workspaces) {
    const ws = rootPackageJson.workspaces;
    if (Array.isArray(ws)) {
      patterns.push(...ws.filter((p: unknown) => typeof p === 'string'));
    } else if (ws && Array.isArray(ws.packages)) {
      patterns.push(...ws.packages.filter((p: unknown) => typeof p === 'string'));
    }
  }

  // turbo.json doesn't declare package globs itself (it defers to
  // package.json#workspaces / pnpm-workspace.yaml) but nx.json can via
  // `workspaceLayout` app/lib dirs — treat those as an additional glob root.
  const nxConfig = readJsonSafe(path.join(projectPath, 'nx.json'));
  if (nxConfig && nxConfig.workspaceLayout) {
    const { appsDir, libsDir } = nxConfig.workspaceLayout as { appsDir?: string; libsDir?: string };
    if (typeof appsDir === 'string' && appsDir) patterns.push(`${appsDir}/*`);
    if (typeof libsDir === 'string' && libsDir) patterns.push(`${libsDir}/*`);
  }

  return Array.from(new Set(patterns.map((p) => p.trim()).filter(Boolean)))
    .filter((p) => !p.startsWith('!'));
}

/**
 * Resolves workspace glob patterns to actual member directories that exist on
 * disk under `projectPath`. Evidence-gated: only directories a glob pattern
 * literally matches are returned — never inferred from naming convention.
 */
export function resolveWorkspaceGlobMembers(projectPath: string, patterns: string[]): string[] {
  if (patterns.length === 0) return [];
  const members = new Set<string>();

  for (const pattern of patterns) {
    try {
      const matches = globSync(pattern, {
        cwd: projectPath,
        ignore: ['**/node_modules/**'],
        nodir: false,
      });
      for (const match of matches) {
        const absolute = path.join(projectPath, match);
        let isDir = false;
        try {
          isDir = fs.statSync(absolute).isDirectory();
        } catch {
          continue;
        }
        if (!isDir) continue;
        members.add(absolute);
        if (members.size >= MAX_GLOB_MEMBERS) return Array.from(members);
      }
    } catch {
      // malformed/unsupported pattern: skip it, evidence-based means we don't guess
    }
  }

  return Array.from(members);
}

/**
 * Full pipeline: read workspace manifests at `projectPath`, resolve their
 * glob patterns against the filesystem, and return member directories that
 * do NOT already have their own package-boundary manifest (those are already
 * discovered by the existing per-directory manifest walk, so returning them
 * again here would just be redundant — callers should still dedupe via a Set
 * regardless, this is a courtesy filter for the common case).
 */
export function discoverWorkspaceGlobRootsWithoutManifest(
  projectPath: string,
  hasOwnPackageBoundaryManifest: (absoluteDir: string) => boolean,
): string[] {
  const patterns = collectWorkspaceGlobPatterns(projectPath);
  if (patterns.length === 0) return [];
  const members = resolveWorkspaceGlobMembers(projectPath, patterns);
  return members.filter((dir) => !hasOwnPackageBoundaryManifest(dir));
}
