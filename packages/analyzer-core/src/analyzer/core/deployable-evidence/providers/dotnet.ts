import * as fs from 'fs-extra';
import * as path from 'path';
import type { DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { IGNORE_GLOBS, safeGlobSync } from '../util';

/**
 * .NET ecosystem (C#, MSBuild) deployable evidence.
 *
 * Tier 2 (runnable entry), evaluated per .csproj (one candidate per project
 * file so a multi-project solution surfaces each runnable project
 * independently):
 *  - `<OutputType>Exe</OutputType>` -> kind 'bin' (or 'server-entry' if the
 *    project also looks like ASP.NET, see below).
 *  - `Sdk="Microsoft.NET.Sdk.Web"` (ASP.NET Core web project) -> kind
 *    'server-entry'.
 *  - `Program.cs` with top-level statements (`WebApplication.CreateBuilder`,
 *    `app.Run()`) or a classic `static ... Main(` -> kind 'bin', upgraded to
 *    'server-entry' when ASP.NET Core signals (`WebApplication`,
 *    `app.Run()`, `app.MapGet` etc.) are present.
 *
 * Tier 3 (package identity):
 *  - Every .csproj as a 'package' candidate (module identity), independent
 *    of runnability — this is what lets a class-library .csproj (no
 *    OutputType Exe, not Web SDK) surface as a non-deployable package that
 *    rolls up under a parent app.
 *  - .sln as a 'package' candidate for the workspace/solution identity, and
 *    to enumerate solution-grouped projects.
 */

const CSPROJ_GLOB = '**/*.csproj';
const SLN_GLOB = '**/*.sln';
const PROGRAM_CS_GLOB = '**/Program.cs';

function readFileSafe(projectPath: string, relFile: string): string | undefined {
  try {
    return fs.readFileSync(path.join(projectPath, relFile), 'utf8');
  } catch {
    return undefined;
  }
}

function globSafe(projectPath: string, patterns: string | string[]): string[] {
  try {
    return safeGlobSync(patterns, { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    return [];
  }
}

function moduleNameFromRoot(rootPath: string, projectPath: string, fallback?: string): string {
  if (rootPath === '.' || rootPath === '') return fallback || path.basename(projectPath);
  return fallback || path.basename(rootPath);
}

function isAspNetWebSdk(content: string): boolean {
  return /<Project[^>]*Sdk\s*=\s*"Microsoft\.NET\.Sdk\.Web"/.test(content);
}

function isOutputTypeExe(content: string): boolean {
  return /<OutputType>\s*Exe\s*<\/OutputType>/i.test(content);
}

function csprojName(content: string, rootPath: string, projectPath: string, csprojFile: string): string {
  const assemblyNameMatch = content.match(/<AssemblyName>([^<]+)<\/AssemblyName>/);
  if (assemblyNameMatch) return assemblyNameMatch[1];
  return moduleNameFromRoot(rootPath, projectPath, path.basename(csprojFile, '.csproj'));
}

/** One candidate per .csproj that looks runnable (Exe OutputType or Web SDK). */
function collectCsprojRunnableTargets(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath } = ctx;
  const out: DeployableEvidence[] = [];
  const csprojFiles = globSafe(projectPath, CSPROJ_GLOB);

  for (const csproj of csprojFiles) {
    const content = readFileSafe(projectPath, csproj);
    if (!content) continue;

    const isWeb = isAspNetWebSdk(content);
    const isExe = isOutputTypeExe(content);
    if (!isWeb && !isExe) continue; // library project — handled by collectPackageIdentity only

    const rootPath = path.dirname(csproj);
    const name = csprojName(content, rootPath, projectPath, csproj);
    const evidence: string[] = [`${csproj}`];
    if (isWeb) evidence.push('Sdk="Microsoft.NET.Sdk.Web"');
    if (isExe) evidence.push('<OutputType>Exe</OutputType>');

    out.push({
      root_path: rootPath,
      name,
      tier: 2,
      kind: isWeb ? 'server-entry' : 'bin',
      evidence,
    });
  }

  return out;
}

/** Program.cs top-level statements / classic Main, per containing project, when not already claimed via .csproj scan. */
function collectProgramCsEntries(ctx: EvidenceCollectionContext, alreadyClaimed: Set<string>): DeployableEvidence[] {
  const { projectPath } = ctx;
  const out: DeployableEvidence[] = [];
  const programFiles = globSafe(projectPath, PROGRAM_CS_GLOB);

  for (const file of programFiles) {
    const content = readFileSafe(projectPath, file);
    if (!content) continue;

    const hasClassicMain = /static\s+(?:async\s+)?(?:Task\s*)?(?:<[^>]+>\s*)?void\s+Main\s*\(/.test(content) ||
      /static\s+(?:async\s+)?int\s+Main\s*\(/.test(content);
    const looksAspNet = /WebApplication\.CreateBuilder/.test(content) || /\bapp\.Run\s*\(/.test(content) || /\bapp\.Map(Get|Post|Put|Delete|Controllers)\b/.test(content);
    // Top-level statements: a Program.cs with no explicit class/Main wrapper
    // but real statements (heuristic: contains a `;` and is not just usings).
    const looksTopLevel = !hasClassicMain && /;/.test(content.replace(/^\s*using\s+[^\n]+\n/gm, ''));

    if (!hasClassicMain && !looksAspNet && !looksTopLevel) continue;

    const rootPath = nearestCsprojRoot(projectPath, file);
    if (alreadyClaimed.has(rootPath)) continue; // module already has a Tier-2 candidate from a .csproj match

    const name = moduleNameFromRoot(rootPath, projectPath);
    out.push({
      root_path: rootPath,
      name,
      tier: 2,
      kind: looksAspNet ? 'server-entry' : 'bin',
      evidence: [
        `Program.cs: ${file}`,
        ...(looksAspNet ? ['WebApplication.CreateBuilder / app.Run() (ASP.NET Core)'] : []),
        ...(hasClassicMain ? ['static void Main(...) present'] : looksTopLevel ? ['top-level statements'] : []),
      ],
    });
    alreadyClaimed.add(rootPath);
  }

  return out;
}

/** Walk upward from a source file toward the project root looking for the nearest .csproj, defaulting to '.'. */
function nearestCsprojRoot(projectPath: string, sourceFile: string): string {
  let dir = path.dirname(sourceFile);
  while (true) {
    let hasCsproj = false;
    try {
      hasCsproj = fs.readdirSync(path.join(projectPath, dir)).some(f => f.endsWith('.csproj'));
    } catch {
      hasCsproj = false;
    }
    if (hasCsproj) return dir;
    const parent = path.dirname(dir);
    if (parent === dir || dir === '.') break;
    dir = parent;
  }
  return path.dirname(sourceFile);
}

/** Tier 3: every .csproj (library or app) as a package/module identity candidate, plus .sln as workspace identity. */
function collectPackageIdentity(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath } = ctx;
  const out: DeployableEvidence[] = [];

  const csprojFiles = globSafe(projectPath, CSPROJ_GLOB);
  for (const csproj of csprojFiles) {
    const content = readFileSafe(projectPath, csproj);
    if (content === undefined) continue;
    const rootPath = path.dirname(csproj);
    const name = csprojName(content, rootPath, projectPath, csproj);
    const versionMatch = content.match(/<Version>([^<]+)<\/Version>/);
    const targetFrameworkMatch = content.match(/<TargetFramework(?:s)?>([^<]+)<\/TargetFramework(?:s)?>/);
    out.push({
      root_path: rootPath,
      name,
      tier: 3,
      kind: 'package',
      evidence: [
        `${csproj}`,
        ...(versionMatch ? [`version: ${versionMatch[1]}`] : []),
        ...(targetFrameworkMatch ? [`TargetFramework: ${targetFrameworkMatch[1]}`] : []),
      ],
    });
  }

  const slnFiles = globSafe(projectPath, SLN_GLOB);
  for (const sln of slnFiles) {
    const content = readFileSafe(projectPath, sln);
    if (content === undefined) continue;
    const rootPath = path.dirname(sln);
    const name = path.basename(sln, '.sln');
    const projectRefs = [...content.matchAll(/Project\("\{[^}]+\}"\)\s*=\s*"([^"]+)"\s*,\s*"([^"]+)"/g)].map(m => m[1]);
    out.push({
      root_path: rootPath,
      name,
      tier: 3,
      kind: 'package',
      evidence: [
        `${sln}`,
        ...(projectRefs.length ? [`solution projects: ${projectRefs.join(', ')}`] : []),
      ],
    });
  }

  return out;
}

function collect(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const csprojRunnable = collectCsprojRunnableTargets(ctx);
  const claimedRoots = new Set<string>(csprojRunnable.map(e => e.root_path));
  const programCsEntries = collectProgramCsEntries(ctx, claimedRoots);
  const packages = collectPackageIdentity(ctx);

  return [...csprojRunnable, ...programCsEntries, ...packages];
}

export const dotnetProvider: EvidenceProvider = {
  id: 'dotnet',
  tier: 2,
  collect,
};
