/**
 * Loads declarative analyzer packs (YAML) from disk and validates them
 * against pack-schema.ts. Packs are pure data — no code execution — so a
 * malformed or malicious pack can, at worst, fail to load or match nothing;
 * it can never run arbitrary logic. See docs/SPEC-ANALYZER-PACKS.md (safety model).
 *
 * Three load tiers (highest precedence last-wins on id collision):
 *   1. built-in bundled packs shipped with analyzer-core (packs/examples/)
 *   2. local project packs declared in `.klaurorc` (`packs: ["./klauro-packs/*.yaml"]`)
 *   3. community registry packs (fetched by id/version — NOT implemented in this
 *      prototype; see spec for the fetch/verify design)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { glob } from 'glob';
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

/** Load every *.pack.yaml / *.pack.yml under a directory (non-recursive glob,
 *  matches the built-in examples/ layout). Bad files are reported, not thrown. */
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

/** Load and validate a single pack file. Never throws. */
export function loadPackFile(filePath: string, tier: LoadedPack['tier'] = 'local'): { pack?: LoadedPack; errors: string[] } {
  let raw: unknown;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    // CORE_SCHEMA: plain data only (no JS-specific !!js/* tags, no custom
    // constructors) — packs are untrusted-by-default (community tier), so
    // parsing must never be able to construct anything beyond JSON-shaped
    // values. js-yaml's `load()` is itself safe-by-default (unlike PyYAML);
    // this schema pin is defense in depth against a future custom Type being
    // added elsewhere in the process's yaml usage.
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

/**
 * Load all applicable packs for a project: built-ins + any local packs the
 * project's `.klaurorc` declares (paths resolved relative to the project
 * root). Local packs with the same `pack` id override a built-in of the same
 * id (local tier wins — mirrors the .klaurorc conventions precedence).
 */
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
  for (const p of localPacks) byId.set(p.pack.pack, p); // local overrides builtin on id collision

  return {
    packs: [...byId.values()],
    errors: [...builtins.errors, ...localErrors],
  };
}
