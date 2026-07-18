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

/** Bare platform/architecture words that name a TARGET, never a PRODUCT.
 *  Real-repo defect (2026-07 hosted reanalysis of a Rust multi-binary
 *  workspace): rows named "windows" and "windows prebuilt" — a script's
 *  APP_NAME/PLATFORM-style variable happened to hold a platform word, which
 *  installerArtifactIdentity accepted as a product name because it was
 *  merely non-empty. A platform word alone (or qualified only by another
 *  platform/build-shape word like "prebuilt") never identifies WHAT ships,
 *  only WHERE/HOW — it must never stand alone as an installer identity. */
const REAL_PLATFORM_WORDS = new Set([
  'windows', 'win', 'win32', 'win64', 'macos', 'mac', 'osx', 'darwin',
  'linux', 'unix', 'x86', 'x64', 'x86_64', 'arm', 'arm64', 'aarch64', 'universal',
]);

/** Build-SHAPE words: describe how/where something was built (prebuilt vs.
 *  from-source, a local vs. remote fetch, a release vs. debug profile), never
 *  what platform it targets nor what it's called. Kept separate from
 *  REAL_PLATFORM_WORDS so cleanScriptDisplayName's "exactly one real
 *  platform" detection isn't confused by a co-occurring build-shape word
 *  (e.g. "build-windows-installer-prebuilt" must resolve to ONE platform,
 *  "windows" — "prebuilt" is noise to strip, not a second platform). */
const BUILD_SHAPE_WORDS = new Set(['prebuilt', 'local', 'remote', 'release', 'debug', 'build']);

const PLATFORM_OR_BUILD_SHAPE_WORDS = new Set([...REAL_PLATFORM_WORDS, ...BUILD_SHAPE_WORDS]);

/** Generic packaging/output NOUNS: describe the SHAPE of a build's output
 *  (the artifacts it produces, a catch-all bucket, a shared/common location),
 *  never a product's own identity. Real-repo defect (2026-07 hosted
 *  reanalysis of a Rust multi-binary workspace): a packaging script whose
 *  own name was nothing but one of these words (or a build-shape word
 *  immediately concatenated with one, e.g. a script literally named
 *  "buildbinaries") minted a standalone Tier-1 installer unit named "base" /
 *  "buildbinaries" — a script's own generic-output-shaped name is not a ship
 *  identity any more than a bare platform word is. Kept separate from
 *  BUILD_SHAPE_WORDS (which describe HOW something was built) since these
 *  describe WHAT KIND of generic bucket it landed in. */
const GENERIC_OUTPUT_NOUN_WORDS = new Set([
  'base', 'binaries', 'binary', 'artifacts', 'artifact', 'output', 'outputs',
  'dist', 'distribution', 'common', 'shared', 'core', 'misc', 'target', 'targets',
  'files', 'scripts',
]);

const NOISE_WORDS = new Set([...PLATFORM_OR_BUILD_SHAPE_WORDS, ...GENERIC_OUTPUT_NOUN_WORDS]);

/**
 * True when `token` — a single word with NO internal separator (so the
 * separator-based tokenizer in isRealProductNameToken/cleanScriptDisplayName
 * never got a chance to split it) — is itself nothing but a concatenation of
 * two or more known noise words (build-shape, platform, or generic-output-
 * noun), e.g. "buildbinaries" = "build" + "binaries". Shape-based, not a
 * literal-string special case: greedily peels the LONGEST matching noise word
 * off the front and requires the ENTIRE token to be consumed by at least two
 * such words before calling it noise, so a real product name that merely
 * starts with a noise-shaped prefix (e.g. "basecamp" -> "base" + "camp", and
 * "camp" is not a noise word) is never rejected — only a token that fully
 * decomposes into noise, with nothing product-shaped left over, is.
 */
function isNoiseCompoundToken(token: string): boolean {
  const lower = token.toLowerCase();
  if (lower.length < 6) return false; // shortest real compound: "base"+"..." etc — avoid false positives on short real words
  const noiseWords = [...NOISE_WORDS].sort((a, b) => b.length - a.length);
  let remaining = lower;
  let piecesConsumed = 0;
  while (remaining.length > 0) {
    const hit = noiseWords.find(word => remaining.startsWith(word));
    if (!hit) return false;
    remaining = remaining.slice(hit.length);
    piecesConsumed += 1;
  }
  return piecesConsumed >= 2;
}

/** Verb-phrase prefixes: a candidate product name that reads as an ACTION
 *  ("resolve version", "build windows installer", "get app name") is a
 *  helper-function/variable-purpose description that leaked through into
 *  product_name, not a product's actual name. Real-repo defect: a row named
 *  "resolve version" — the productName fallback resolved to a helper
 *  script's own filename (`resolve-version.sh`) after no APP_NAME/
 *  ProductName directive was found in its content, because that script isn't
 *  an installer/product at all, merely a version-resolution utility whose
 *  content incidentally matched an installer-role keyword. */
const VERB_PHRASE_PREFIX = /^(resolve|build|get|set|run|make|install|uninstall|update|check|verify|clean|copy|package|bundle|zip|fetch|prepare|generate|create|deploy|configure|setup|validate|test|start|stop|restart|load|save|write|read|parse|compute|calculate|print|log|assert|ensure|wait|retry|list|show|find|search|sign|notarize|publish|download|upload)\b/i;

/** True when `value` is shaped like a real product/artifact name, as opposed
 *  to a parse-artifact fragment (assignment/comparison leftovers like "="),
 *  a bare platform/build-shape word ("windows", "local"), or a verb phrase
 *  describing an action rather than naming a product ("resolve version").
 *  This is the identity-layer half of the "reject non-artifact-shaped
 *  identities" fix (see installer-identity iteration 2): the extraction
 *  layer (distribution-artifact-analyzer.ts) was tightened to stop
 *  CAPTURING junk like "=" in the first place, but this filter is kept as
 *  defense-in-depth for whatever still gets through — a manifest/analyzer
 *  producing a legitimately weird productName should fail closed here rather
 *  than mint a phantom installer unit.
 *
 *  Belt-and-suspenders against unresolved shell/NSIS template variables: the
 *  extraction layer (distribution-artifact-analyzer.ts's resolveTemplateVar)
 *  already rejects a captured name when a `${VAR}`/`$VAR` inside it fails to
 *  resolve, but whatever still gets through (a different extraction path, a
 *  future analyzer, hand-built metadata) must not mint a unit named e.g.
 *  "Acme $BINARY_NAME" — an unresolved template remnant is never a real
 *  product name, regardless of how it arrived here. */
function isRealProductNameToken(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 3) return false;
  if (!/^[A-Za-z]/.test(trimmed)) return false; // rejects "=", "==", digits-only, punctuation
  if (/\$\{[A-Za-z0-9_]+\}|\$[A-Za-z_][A-Za-z0-9_]*/.test(trimmed)) return false; // rejects unresolved $VAR/${VAR} template remnants
  if (VERB_PHRASE_PREFIX.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  // Every token is a platform/build-shape/generic-output-noun word ("windows",
  // "windows prebuilt", "base") -> names a target/shape/bucket, never a
  // product.
  if (tokens.every(token => NOISE_WORDS.has(token.toLowerCase()))) return false;
  // A single un-separated token that fully decomposes into noise words
  // concatenated together ("buildbinaries" = "build" + "binaries") is the
  // same class of non-identity, just missing the separator a tokenizer needs.
  if (tokens.length === 1 && isNoiseCompoundToken(tokens[0])) return false;
  return true;
}

/** Normalizes a display NAME for comparison (case/whitespace only). Deliberately
 *  does NOT strip a ship-artifact extension — the extension is part of what
 *  distinguishes one platform's artifact from another's (see
 *  installerArtifactIdentity) and must never be normalized away when used in
 *  an identity key. */
function normalizeIdentityToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

/** Resolve the artifact identity a distribution-artifact node's metadata
 *  actually names, so multiple nodes that reference the SAME shipped
 *  artifact (e.g. a build script and a release script that both prepare the
 *  same "MyApp.exe") merge into one unit, while nodes naming no artifact at
 *  all resolve to `undefined` and create nothing. Keyed primarily on the
 *  resolved ship-artifact filename INCLUDING its extension (.exe/.msi/.dmg/
 *  .pkg/.deb/.rpm/.AppImage) when one is present — that is unambiguous
 *  positive evidence of a specific built artifact, and the extension must be
 *  kept in the key (not stripped) so per-platform installers for the same
 *  product (a Windows "MyApp.exe" vs a macOS "MyApp.dmg" vs a Linux
 *  "MyApp.deb") resolve to DIFFERENT identities and are never silently
 *  collapsed into one just because they share a product name. Falls back to
 *  the declared product name qualified by platform when no ship-artifact
 *  filename is resolvable. */
function installerArtifactIdentity(metadata: Record<string, any>): { key: string; name: string } | undefined {
  const binaryNames: string[] = arrayOf(metadata.binary_names);
  const shipArtifact = binaryNames.find(name => SHIP_ARTIFACT_EXTENSION.test(name));
  if (shipArtifact) {
    // A ship-artifact FILENAME is unambiguous positive evidence on its own —
    // it never needs the product-name-shape gate below. The declared
    // product_name is still preferred for `name` when present, but only when
    // it is itself real-product-shaped; a junk product_name must not win out
    // over the perfectly good artifact filename.
    const declaredName = String(metadata.product_name || '');
    const name = isRealProductNameToken(declaredName) ? declaredName : shipArtifact;
    return { key: `artifact:${normalizeIdentityToken(shipArtifact)}`, name };
  }
  const productName = String(metadata.product_name || '').trim();
  if (!productName || !isRealProductNameToken(productName)) return undefined;
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
/** Real shell function bodies are never remotely this large (the biggest
 *  legitimate installer scripts in the wild run a few KB total); this bounds
 *  funcBodyRegex's body-search window so an UNCLOSED `{` (no matching `\n}`
 *  anywhere in the rest of the file — adversarial-but-legitimate content, not
 *  a crafted attack) costs at most one bounded scan instead of a scan to EOF.
 *  See funcBodyRegex's own PERFORMANCE note for the full story. */
const MAX_FUNC_BODY_SEARCH_CHARS = 2_000;

function resolveIndirectCargoPackageMembers(content: string): string[] {
  const members: string[] = [];
  // PERFORMANCE (regex-hang-hunt, 2026-07, second escape of the class fixed in
  // 43ac675e): the lazy `[\s\S]*?` here used to have NO upper bound, so it
  // scanned forward looking for `\n}` all the way to EOF whenever a `name() {`
  // header had no matching close later in the file. That is fine for a single
  // header near EOF, but a script shape with MANY such headers scattered
  // through the file (e.g. large generated/embedded content with many `{` and
  // sparse or absent `\n}` closings) makes EVERY header's lazy scan re-walk
  // most of the remaining content: O(headers x remaining-length), quadratic
  // in file size. Measured directly: doubling a pathological input's size
  // roughly QUADRUPLED matchAll's running time (500->8000 "unclosed function"
  // lines: 1.4ms -> 244ms, consistent with O(n^2)). Bounding the body-search
  // window to MAX_FUNC_BODY_SEARCH_CHARS caps each header's worst-case scan to
  // a constant, making the whole matchAll linear in file size regardless of
  // how many headers never find a close — a header whose body would exceed
  // the cap simply fails to match here (same effect as "not a resolvable
  // indirect-cargo function"), which is correct: no real installer function
  // is anywhere close to MAX_FUNC_BODY_SEARCH_CHARS long.
  const funcBodyRegex = new RegExp(
    `(?:^|\\n)\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\(\\)\\s*\\{([\\s\\S]{0,${MAX_FUNC_BODY_SEARCH_CHARS}}?)\\n\\}`,
    'g',
  );
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

    // Resolve real values from literal call sites: `funcName "literal" ...`.
    // The inter-token/leading separator is deliberately HORIZONTAL whitespace
    // only (`[^\S\n]`, not `\s`), never a bare newline: with `\s*` the token
    // repetition greedily crosses line boundaries and swallows a SECOND,
    // unrelated call to the same function on the next line into the SAME
    // match (e.g. `build_binary "client")\nSERVICE_BINARY=$(build_binary
    // "client-service")` collapsing into one match whose args become
    // `['client', ')', 'SERVICE_BINARY=$(build_binary', 'client-service', ...]`),
    // so `matchAll` never produces a distinct match for the second call site
    // and its member is silently dropped. Real shell call sites are one
    // statement per line; bounding the token run to the current line fixes
    // this without weakening the quoted-arg / bare-token matching itself.
    const callRegex = new RegExp(`\\b${funcName}[^\\S\\n]+((?:"[^"]*"|'[^']*'|\\S+)[^\\S\\n]*){0,6}`, 'g');
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

/** Turn "windows"/"mac"/"macos"/"linux" into "Windows"/"Mac"/"macOS"/"Linux"
 *  for display. Kept intentionally tiny (not a general title-caser) since it
 *  only ever renders a platform token already drawn from REAL_PLATFORM_WORDS. */
function capitalizePlatformWord(word: string): string {
  if (word === 'macos' || word === 'osx') return 'macOS';
  if (word === 'mac') return 'Mac';
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Derive a clean, product-shaped display name for a packaging SCRIPT file,
 *  instead of echoing its raw basename verbatim. Real-repo defect (2026-07
 *  hosted reanalysis): scripts named `build-windows-installer-prebuilt.sh`
 *  and `build-mac-installer.sh` each minted their OWN standalone installer
 *  row named after their literal filename — the scripts' names, not the
 *  platform artifact they build. Strips build/packaging verb and
 *  build-shape tokens (build/installer/setup/prebuilt/package/bundle) and,
 *  when the remaining/removed tokens name exactly one platform, renders
 *  "<Platform> Installer" so multiple scripts that build the SAME platform's
 *  artifact converge on the SAME name (and therefore the same merged unit
 *  via mergeCrossCollectorInstallerUnits's name-equality merge) instead of
 *  minting one phantom unit per script. */
function cleanScriptDisplayName(relativeFile: string): string {
  const base = path.basename(relativeFile, path.extname(relativeFile));
  const STRIP_TOKENS = /^(installer|install|uninstall|uninstaller|setup|manifest|package|bundle)$/i;
  const tokens = base.split(/[-_\s]+/).filter(Boolean);
  const platformTokens: string[] = [];
  const kept: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    // Real platform words (windows/mac/linux/...) are the ONLY thing that
    // can populate platformTokens — build-shape words (prebuilt/build/
    // release/debug/local/remote) are noise to strip, never a second
    // "platform" that would otherwise defeat the exactly-one-platform check
    // below (see BUILD_SHAPE_WORDS doc comment).
    if (REAL_PLATFORM_WORDS.has(lower)) {
      platformTokens.push(lower);
      continue;
    }
    if (STRIP_TOKENS.test(token) || BUILD_SHAPE_WORDS.has(lower)) continue;
    kept.push(token);
  }
  const uniquePlatforms = [...new Set(platformTokens)];
  if (uniquePlatforms.length === 1 && kept.length === 0) {
    return `${capitalizePlatformWord(uniquePlatforms[0])} Installer`;
  }
  const joined = kept.join(' ').trim();
  if (joined && isRealProductNameToken(joined)) {
    return uniquePlatforms.length === 1 ? `${joined} (${capitalizePlatformWord(uniquePlatforms[0])})` : joined;
  }
  // Nothing product-shaped survived stripping — fall back to the raw
  // basename rather than fabricating a name; downstream cross-collector
  // merge / bundling still functions off ships_paths evidence.
  return base;
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
      name: cleanScriptDisplayName(relativeFile),
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
