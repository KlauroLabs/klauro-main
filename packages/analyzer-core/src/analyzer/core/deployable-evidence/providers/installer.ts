import * as fs from 'fs-extra';
import * as path from 'path';
import type { DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { arrayOf, IGNORE_GLOBS, safeGlobSync } from '../util';






const SHIP_ARTIFACT_EXTENSION = /\.(exe|msi|dmg|pkg|deb|rpm|appimage)$/i;









const REAL_PLATFORM_WORDS = new Set([
  'windows', 'win', 'win32', 'win64', 'macos', 'mac', 'osx', 'darwin',
  'linux', 'unix', 'x86', 'x64', 'x86_64', 'arm', 'arm64', 'aarch64', 'universal',
]);








const BUILD_SHAPE_WORDS = new Set(['prebuilt', 'local', 'remote', 'release', 'debug', 'build']);

const PLATFORM_OR_BUILD_SHAPE_WORDS = new Set([...REAL_PLATFORM_WORDS, ...BUILD_SHAPE_WORDS]);












const GENERIC_OUTPUT_NOUN_WORDS = new Set([
  'base', 'binaries', 'binary', 'artifacts', 'artifact', 'output', 'outputs',
  'dist', 'distribution', 'common', 'shared', 'core', 'misc', 'target', 'targets',
  'files', 'scripts',
]);

const NOISE_WORDS = new Set([...PLATFORM_OR_BUILD_SHAPE_WORDS, ...GENERIC_OUTPUT_NOUN_WORDS]);














function isNoiseCompoundToken(token: string): boolean {
  const lower = token.toLowerCase();
  if (lower.length < 6) return false;
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










const VERB_PHRASE_PREFIX = /^(resolve|build|get|set|run|make|install|uninstall|update|check|verify|clean|copy|package|bundle|zip|fetch|prepare|generate|create|deploy|configure|setup|validate|test|start|stop|restart|load|save|write|read|parse|compute|calculate|print|log|assert|ensure|wait|retry|list|show|find|search|sign|notarize|publish|download|upload)\b/i;




















function isRealProductNameToken(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 3) return false;
  if (!/^[A-Za-z]/.test(trimmed)) return false;
  if (/\$\{[A-Za-z0-9_]+\}|\$[A-Za-z_][A-Za-z0-9_]*/.test(trimmed)) return false;
  if (VERB_PHRASE_PREFIX.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/).filter(Boolean);



  if (tokens.every(token => NOISE_WORDS.has(token.toLowerCase()))) return false;



  if (tokens.length === 1 && isNoiseCompoundToken(tokens[0])) return false;
  return true;
}






function normalizeIdentityToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}















function installerArtifactIdentity(metadata: Record<string, any>): { key: string; name: string } | undefined {
  const binaryNames: string[] = arrayOf(metadata.binary_names);
  const shipArtifact = binaryNames.find(name => SHIP_ARTIFACT_EXTENSION.test(name));
  if (shipArtifact) {





    const declaredName = String(metadata.product_name || '');
    const name = isRealProductNameToken(declaredName) ? declaredName : shipArtifact;
    return { key: `artifact:${normalizeIdentityToken(shipArtifact)}`, name };
  }
  const productName = String(metadata.product_name || '').trim();
  if (!productName || !isRealProductNameToken(productName)) return undefined;
  const platforms: string[] = arrayOf(metadata.platforms).map(String).sort();
  return { key: `product:${normalizeIdentityToken(productName)}::${platforms.join(',')}`, name: productName };
}





function mergeInstallerUnit(units: Map<string, DeployableEvidence>, key: string, candidate: DeployableEvidence): void {
  const existing = units.get(key);
  if (!existing) {
    units.set(key, candidate);
    return;
  }
  existing.evidence = [...new Set([...existing.evidence, ...candidate.evidence])];
  const entryFiles = [...new Set([...(existing.entry_files || []), ...(candidate.entry_files || [])])];
  existing.entry_files = entryFiles.length > 0 ? entryFiles : undefined;
  existing.ships_paths = [...new Set([...(existing.ships_paths || []), ...(candidate.ships_paths || [])])];
}





















function collectFromDistributionArtifactNodes(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const units = new Map<string, DeployableEvidence>();

  for (const node of ctx.nodes) {
    const metadata = (node.metadata || {}) as Record<string, any>;
    if (metadata.topology_surface !== 'distribution-artifacts') continue;
    const artifactKind = String(metadata.artifact_kind || '');
    if (artifactKind !== 'installer') continue;

    const identity = installerArtifactIdentity(metadata);
    if (!identity) continue;

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
      entry_files: file ? [file] : undefined,
      ships_paths: binaryNames,
    });
  }

  return [...units.values()];
}


























const MAX_FUNC_BODY_SEARCH_CHARS = 2_000;

function resolveIndirectCargoPackageMembers(content: string): string[] {
  const members: string[] = [];

















  const funcBodyRegex = new RegExp(
    `(?:^|\\n)\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\(\\)\\s*\\{([\\s\\S]{0,${MAX_FUNC_BODY_SEARCH_CHARS}}?)\\n\\}`,
    'g',
  );
  for (const funcMatch of content.matchAll(funcBodyRegex)) {
    const funcName = funcMatch[1];
    const body = funcMatch[2];


    const paramAliases = new Map<string, string>();
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













    const callRegex = new RegExp(`\\b${funcName}[^\\S\\n]+((?:"[^"]*"|'[^']*'|\\S+)[^\\S\\n]*){0,6}`, 'g');
    for (const callMatch of content.matchAll(callRegex)) {

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




function capitalizePlatformWord(word: string): string {
  if (word === 'macos' || word === 'osx') return 'macOS';
  if (word === 'mac') return 'Mac';
  return word.charAt(0).toUpperCase() + word.slice(1);
}













function cleanScriptDisplayName(relativeFile: string): string {
  const base = path.basename(relativeFile, path.extname(relativeFile));
  const STRIP_TOKENS = /^(installer|install|uninstall|uninstaller|setup|manifest|package|bundle)$/i;
  const tokens = base.split(/[-_\s]+/).filter(Boolean);
  const platformTokens: string[] = [];
  const kept: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();





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



  return base;
}









const MAX_COPY_COMMAND_SEARCH_CHARS = 2000;












const COPY_TARGET_TOKEN = /(?:^|[\s"'])(?:\.\/)?target\/(?:release|debug)\/([A-Za-z0-9_.-]+)/g;

















function collectCopyTargetMembers(content: string): string[] {
  const members: string[] = [];
  for (const commandMatch of content.matchAll(/\b(?:cp|install|mv)\s+[^\n]{0,2000}/g)) {
    const commandText = commandMatch[0].slice(0, MAX_COPY_COMMAND_SEARCH_CHARS);
    for (const tokenMatch of commandText.matchAll(COPY_TARGET_TOKEN)) {
      members.push(tokenMatch[1]);
    }
  }
  return members;
}







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
    collectCopyTargetMembers(content).forEach(name => members.add(name));
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
      entry_files: [relativeFile],
      ships_paths: [...members],
    });
  }

  return out;
}










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
      const entryFiles = [...new Set([...(match.entry_files || []), ...(candidate.entry_files || [])])];
      match.entry_files = entryFiles.length > 0 ? entryFiles : undefined;
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
