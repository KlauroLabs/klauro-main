import * as fs from 'fs-extra';
import * as path from 'path';
import type { DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { arrayOf, IGNORE_GLOBS, safeGlobSync } from '../util';

/** Installers, desktop entries, service units, install/release scripts (distribution-artifact-analyzer output). */
function collectFromDistributionArtifactNodes(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const out: DeployableEvidence[] = [];

  for (const node of ctx.nodes) {
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

/** Recover `cargo build/install -p <package>` membership when the package
 *  name is passed through a shell FUNCTION PARAMETER rather than written
 *  literally on the cargo line — a common indirection in real installer
 *  scripts, e.g.:
 *    build_binary() {
 *      local binary_name=$1
 *      cargo build --release -p "$binary_name"
 *    }
 *    CLIENT_BINARY=$(build_binary "client")
 *    ZERACD_BINARY=$(build_binary "zeracd")
 *  The direct `-p\s+([A-Za-z0-9_-]+)` regex only matches a literal package
 *  name; it can't see through `"$binary_name"`, so real bundle membership
 *  (here: client + zeracd, the two binaries this installer actually ships
 *  together) goes completely undetected. This walks each shell function
 *  whose body both (a) binds a `local <param>=$N` (or reads `$N` directly)
 *  and (b) has a `cargo build|install ... -p "$<param>"` line referencing
 *  that same parameter, then resolves the parameter's real values from every
 *  literal-string call site of that function elsewhere in the script
 *  (`funcname "literal" ...`), attributing position N's literal as a member. */
function resolveIndirectCargoPackageMembers(content: string): string[] {
  const members: string[] = [];
  const funcBodyRegex = /(?:^|\n)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{([\s\S]*?)\n\}/g;
  for (const funcMatch of content.matchAll(funcBodyRegex)) {
    const funcName = funcMatch[1];
    const body = funcMatch[2];
    // Which positional parameter ($1, $2, ...) does a cargo -p arg reference,
    // directly or via a `local name=$N` alias resolved back to its position?
    const paramAliases = new Map<string, string>(); // alias name -> $N
    for (const aliasMatch of body.matchAll(/\blocal\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\$(\d+)\b/g)) {
      paramAliases.set(aliasMatch[1], `$${aliasMatch[2]}`);
    }
    let targetPosition: number | undefined;
    for (const cargoMatch of body.matchAll(/cargo\s+(?:build|install)\b[^\n]*-p\s+"?\$(\{?)([A-Za-z_][A-Za-z0-9_]*)\}?"?/g)) {
      const referenced = cargoMatch[2];
      const positional = /^\d+$/.test(referenced) ? `$${referenced}` : paramAliases.get(referenced);
      if (positional) {
        const position = Number(positional.slice(1));
        if (Number.isFinite(position) && position > 0) { targetPosition = position; break; }
      }
    }
    if (!targetPosition) continue;

    // Resolve real values from literal call sites: `funcName "literal" ...`
    const callRegex = new RegExp(`\\b${funcName}\\s+((?:"[^"]*"|'[^']*'|\\S+)\\s*){0,6}`, 'g');
    for (const callMatch of content.matchAll(callRegex)) {
      // Skip the definition site itself (immediately followed by `()`).
      if (new RegExp(`\\b${funcName}\\s*\\(\\)`).test(callMatch[0])) continue;
      const rawArgs = callMatch[1] ? callMatch[0].slice(funcName.length).trim() : '';
      if (!rawArgs) continue;
      const args = [...rawArgs.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
      const value = args[targetPosition - 1];
      if (value && /^[A-Za-z0-9_-]+$/.test(value) && !value.startsWith('$')) members.push(value);
    }
  }
  return members;
}

/** Installers / packaging shell scripts (e.g. build-installer.sh) that bundle
 *  multiple binaries into one distribution artifact. Reads `cargo build -p X`
 *  args plus `cp target/release/<bin> ...` copy targets to recover real
 *  membership, independent of whether the Distribution Artifact Analyzer's
 *  own node pipeline fired for this file. */
function collectFromInstallerScripts(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath } = ctx;
  const out: DeployableEvidence[] = [];
  let files: string[] = [];
  try {
    files = safeGlobSync(['**/*installer*.sh', '**/build-installer.sh', '**/*installer*.bash'], {
      cwd: projectPath,
      ignore: IGNORE_GLOBS,
      nodir: true,
      absolute: false,
    });
  } catch {
    return out;
  }

  for (const relativeFile of files) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(projectPath, relativeFile), 'utf8');
    } catch {
      continue;
    }

    const members = new Set<string>();
    for (const match of content.matchAll(/cargo\s+(?:build|install)\b[^\n]*/g)) {
      for (const pkgMatch of match[0].matchAll(/-p\s+([A-Za-z0-9_-]+)/g)) members.add(pkgMatch[1]);
    }
    for (const match of content.matchAll(/\bcp\s+[^\n]*target\/(?:release|debug)\/([A-Za-z0-9_-]+)/g)) {
      members.add(match[1]);
    }
    resolveIndirectCargoPackageMembers(content).forEach(name => members.add(name));

    if (!members.size) continue;

    out.push({
      root_path: '.',
      name: path.basename(relativeFile, path.extname(relativeFile)),
      tier: 1,
      kind: 'installer',
      evidence: [
        `installer script: ${relativeFile}`,
        `bundles: ${[...members].join(', ')}`,
      ],
      ships_paths: [...members],
    });
  }

  return out;
}

function collect(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  return [...collectFromDistributionArtifactNodes(ctx), ...collectFromInstallerScripts(ctx)];
}

export const installerProvider: EvidenceProvider = {
  id: 'installer',
  tier: 1,
  collect,
};
