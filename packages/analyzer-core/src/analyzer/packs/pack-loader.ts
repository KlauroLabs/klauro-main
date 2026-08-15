











import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as yaml from 'js-yaml';
import { cachedGlob as glob } from '../core/glob-cache';
import { validatePack, Pack } from './pack-schema';

export interface LoadedPack {
  pack: Pack;
  sourcePath: string;
  tier: 'builtin' | 'local' | 'registry';
}

export interface PackLoadError {
  sourcePath: string;
  errors: string[];
}

export interface PackLoadResult {
  packs: LoadedPack[];
  errors: PackLoadError[];
}

const BUILTIN_PACKS_DIR = path.join(__dirname, 'examples');



export async function loadPacksFromDir(dir: string, tier: LoadedPack['tier']): Promise<PackLoadResult> {
  const packs: LoadedPack[] = [];
  const errors: PackLoadError[] = [];
  if (!fs.existsSync(dir)) return { packs, errors };

  const files = await glob('**/*.pack.{yaml,yml}', { cwd: dir, nodir: true, absolute: true });
  for (const file of files) {
    const result = loadPackFile(file, tier);
    if (result.pack) packs.push(result.pack);
    else errors.push({ sourcePath: file, errors: result.errors });
  }
  return { packs, errors };
}


export function loadPackFile(filePath: string, tier: LoadedPack['tier'] = 'local'): { pack?: LoadedPack; errors: string[] } {
  let raw: unknown;
  try {
    const content = fs.readFileSync(filePath, 'utf8');






    raw = yaml.load(content, { schema: yaml.CORE_SCHEMA });
  } catch (error) {
    return { errors: [`could not parse YAML: ${(error as Error).message}`] };
  }

  const validation = validatePack(raw);
  if (!validation.ok || !validation.pack) {
    return { errors: validation.errors };
  }

  return { pack: { pack: validation.pack, sourcePath: filePath, tier }, errors: [] };
}







export async function loadPacksForProject(projectPath: string, localPackGlobs: string[] = []): Promise<PackLoadResult> {
  const builtins = await loadPacksFromDir(BUILTIN_PACKS_DIR, 'builtin');
  const localPacks: LoadedPack[] = [];
  const localErrors: PackLoadError[] = [];

  for (const patternRaw of localPackGlobs) {
    const pattern = path.isAbsolute(patternRaw) ? patternRaw : path.join(projectPath, patternRaw);
    const matches = await glob(pattern, { nodir: true, absolute: true });
    for (const file of matches) {
      const result = loadPackFile(file, 'local');
      if (result.pack) localPacks.push(result.pack);
      else localErrors.push({ sourcePath: file, errors: result.errors });
    }
  }

  const byId = new Map<string, LoadedPack>();
  for (const p of builtins.packs) byId.set(p.pack.pack, p);
  for (const p of localPacks) byId.set(p.pack.pack, p);

  return {
    packs: [...byId.values()],
    errors: [...builtins.errors, ...localErrors],
  };
}

export async function semanticPackIdentityForProject(
  projectPath: string,
  localPackGlobs: string[] = []
): Promise<string[]> {
  const loaded = await loadPacksForProject(projectPath, localPackGlobs);
  const sources = new Map<string, string>();
  for (const item of loaded.packs) sources.set(item.sourcePath, item.tier);
  for (const error of loaded.errors) {
    if (!sources.has(error.sourcePath)) sources.set(error.sourcePath, 'invalid');
  }

  return [...sources.entries()].map(([sourcePath, tier]) => {
    let contentHash = 'missing';
    try {
      contentHash = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
    } catch {
    }
    const sourceIdentity = tier === 'local'
      ? path.relative(projectPath, sourcePath).replace(/\\/g, '/')
      : path.basename(sourcePath);
    return `${tier}:${sourceIdentity}:${contentHash}`;
  }).sort();
}
