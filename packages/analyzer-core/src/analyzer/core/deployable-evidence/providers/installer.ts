import * as fs from 'fs-extra';
import * as path from 'path';
import type { DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { arrayOf, IGNORE_GLOBS, safeGlobSync } from '../util';

/** A recognized built-artifact file extension a packaging step actually
 *  ships/runs: this is the "distinct SHIP ARTIFACT identity" the doctrine in
 *  docs/SPEC-DEPLOYABLE-DETECTION.md requires before something counts as an
 *  installer ship unit, as opposed to a script that merely prepares/describes
 *  one. */
const SHIP_ARTIFACT_EXTENSION = /\.(exe|msi|dmg|pkg|deb|rpm|appimage)$/i;

function normalizeIdentityToken(value: string): string {
  return value.replace(SHIP_ARTIFACT_EXTENSION, '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

/** Resolve the artifact identity a distribution-artifact node's metadata
 *  actually names, so multiple nodes that reference the SAME shipped
 *  artifact (e.g. a build script and a release script that both prepare the
 *  same "MyApp.exe") merge into one unit, while nodes naming no artifact at
 *  all resolve to `undefined` and create nothing. Keyed primarily on a
 *  resolved ship-artifact filename (.exe/.msi/.dmg/.pkg/.deb/.rpm/
 *  .AppImage) when one is present — that is unambiguous positive evidence of
 *  a specific built artifact. Falls back to the declared product name
 *  qualified by platform, so per-platform installers for the same product
 *  (a Windows .exe vs a macOS .dmg vs a Linux .deb) still resolve to
 *  DIFFERENT identities and are never silently collapsed into one. */
function installerArtifactIdentity(metadata: Record<string, any>): { key: string; name: string } | undefined {
  const binaryNames: string[] = arrayOf(metadata.binary_names);
  const shipArtifact = binaryNames.find(name => SHIP_ARTIFACT_EXTENSION.test(name));
  if (shipArtifact) {
    return { key: `artifact:${normalizeIdentityToken(shipArtifact)}`, name: String(metadata.product_name || shipArtifact) };
  }
  const productName = String(metadata.product_name || '').trim();
  if (!productName) return undefined;
  const platforms: string[] = arrayOf(metadata.platforms).map(String).sort();
  return { key: `product:${normalizeIdentityToken(productName)}::${platforms.join(',')}`, name: productName };
}

/** Merge a candidate installer unit into `units` by identity key, unioning
 *  evidence and ships_paths rather than adding a second row — this is the
 *  "multiple scripts producing/preparing the SAME artifact dedupe into ONE
 *  unit" half of the doctrine. */
function mergeInstallerUnit(units: Map<string, DeployableEvidence>, key: string, candidate: DeployableEvidence): void {
  const existing = units.get(key);
  if (!existing) {
    units.set(key, candidate);
    return;
  }
  existing.evidence = [...new Set([...existing.evidence, ...candidate.evidence])];
  existing.ships_paths = [...new Set([...(existing.ships_paths || []), ...(candidate.ships_paths || [])])];
}

/** Installers (distribution-artifact-analyzer output). A packaging/release/
 *  cleanup SCRIPT is evidence contributing to an installer unit, not a unit
 *  itself: only nodes the analyzer itself classified as `artifact_kind:
 *  'installer'` (a genuine NSIS/WiX manifest, or a script matched by
 *  installer-role heuristics — makensis/msiexec/dmg/pkgbuild/create-dmg, or
 *  an explicit "installer" filename) are ship declarations. Every other
 *  distribution-artifact kind — desktop entries, systemd service units, and
 *  (critically) the broad shell/release/powershell/batch SCRIPT kinds that
 *  make up the bulk of a real repo's packaging surface — describes HOW
 *  something ships, but is never itself a distinct thing that ships.
 *  Previously this coerced every distribution-artifact node into
 *  kind:'installer' unconditionally (`artifactKind === 'installer' ? … :
 *  'installer'` — a dead conditional that always took the same branch),
 *  turning dozens of unrelated packaging/cleanup scripts into phantom
 *  installer deployables (measured: 47 shell-script + 11 release-script + 3
 *  powershell nodes on a real repo produced 71 installer rows for ~2-3 real
 *  installers). Nodes that DO carry a genuine installer classification are
 *  further required to name a resolvable ship-artifact identity (see
 *  installerArtifactIdentity) and merged by that identity so multiple
 *  scripts/manifests describing the same artifact collapse into one row. */
function collectFromDistributionArtifactNodes(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const units = new Map<string, DeployableEvidence>();

  for (const node of ctx.nodes) {
    const metadata = (node.metadata || {}) as Record<string, any>;
    if (metadata.topology_surface !== 'distribution-artifacts') continue;
    const artifactKind = String(metadata.artifact_kind || '');
    if (artifactKind !== 'installer') continue;

    const identity = installerArtifactIdentity(metadata);
    if (!identity) continue; // no resolvable ship-artifact identity -> not a unit

    const file = node.source?.file || '';
    const binaryNames: string[] = arrayOf(metadata.binary_names);
    const evidence: string[] = [`${artifactKind}: ${file}`];
    if (metadata.distribution_role) evidence.push(`role: ${metadata.distribution_role}`);
    if (binaryNames.length) evidence.push(`binaries: ${binaryNames.join(', ')}`);
    const installPaths: string[] = arrayOf(metadata.install_paths);
    if (installPaths.length) evidence.push(`install paths: ${installPaths.join(', ')}`);

    mergeInstallerUnit(units, identity.key, {
      root_path: path.dirname(file) || '.',
      name: identity.name,
      tier: 1,
      kind: 'installer',
      evidence,
      ships_paths: binaryNames,
    });
  }

  return [...units.values()];
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
 *    DAEMON_BINARY=$(build_binary "daemon")
 *  The direct `-p\s+([A-Za-z0-9_-]+)` regex only matches a literal package
 *  name; it can't see through `"$binary_name"`, so real bundle membership
 *  (here: client + daemon, the two binaries this installer actually ships
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

/** Merge installer units discovered independently by the two collectors
 *  above (a Distribution Artifact Analyzer node vs. this file's own
 *  installer-script regex scan can both fire for the same physical script,
 *  e.g. build-installer.sh) when — and only when — they resolve to the SAME
 *  ship-artifact identity or cite the literal same source file. This is the
 *  conservative half of "evidence-gated merge": positive, unambiguous
 *  evidence only, never a merge on name similarity or shared incidental
 *  tokens (which real packaging scripts are full of and would otherwise
 *  over-merge unrelated installers together). */
function mergeCrossCollectorInstallerUnits(candidates: DeployableEvidence[]): DeployableEvidence[] {
  const merged: DeployableEvidence[] = [];
  const fileOf = (evidence: string[]): string | undefined => evidence[0]?.split(': ').slice(1).join(': ') || undefined;

  for (const candidate of candidates) {
    if (candidate.kind !== 'installer') { merged.push(candidate); continue; }
    const candidateFile = fileOf(candidate.evidence);
    const match = merged.find(existing => {
      if (existing.kind !== 'installer') return false;
      if (normalizeIdentityToken(existing.name) === normalizeIdentityToken(candidate.name) && existing.name) return true;
      const existingFile = fileOf(existing.evidence);
      return Boolean(existingFile && candidateFile && existingFile === candidateFile);
    });
    if (match) {
      match.evidence = [...new Set([...match.evidence, ...candidate.evidence])];
      match.ships_paths = [...new Set([...(match.ships_paths || []), ...(candidate.ships_paths || [])])];
    } else {
      merged.push({ ...candidate });
    }
  }
  return merged;
}

function collect(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  return mergeCrossCollectorInstallerUnits([...collectFromDistributionArtifactNodes(ctx), ...collectFromInstallerScripts(ctx)]);
}

export const installerProvider: EvidenceProvider = {
  id: 'installer',
  tier: 1,
  collect,
};
