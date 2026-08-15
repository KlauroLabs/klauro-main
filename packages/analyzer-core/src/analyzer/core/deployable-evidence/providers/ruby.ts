import * as fs from 'fs-extra';
import * as path from 'path';
import type { DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { IGNORE_GLOBS, safeDeployableName, safeGlobSync } from '../util';


function collectRackup(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
  const out: DeployableEvidence[] = [];
  let files: string[] = [];
  try {
    files = safeGlobSync('**/config.ru', { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    files = [];
  }
  for (const file of files) {
    const root = path.dirname(file);
    out.push({
      root_path: root,
      name: path.basename(root) === '.' ? safeDeployableName(displayName || path.basename(projectPath)) : path.basename(root),
      tier: 2,
      kind: 'server-entry',
      evidence: [`config.ru (rackup): ${file}`],
    });
  }
  return out;
}


function collectRailsApp(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
  const out: DeployableEvidence[] = [];
  let files: string[] = [];
  try {
    files = safeGlobSync(['**/bin/rails', '**/bin/rake'], { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    files = [];
  }
  const seenRoots = new Set<string>();
  for (const file of files) {

    const root = path.dirname(path.dirname(file));
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    out.push({
      root_path: root === '' ? '.' : root,
      name: path.basename(root) === '.' || root === '' ? safeDeployableName(displayName || path.basename(projectPath)) : path.basename(root),
      tier: 2,
      kind: 'server-entry',
      evidence: [`Rails app entry: ${file}`],
    });
  }
  return out;
}


function collectGemExecutables(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath } = ctx;
  const out: DeployableEvidence[] = [];

  let gemspecFiles: string[] = [];
  try {
    gemspecFiles = safeGlobSync('**/*.gemspec', { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    gemspecFiles = [];
  }
  for (const manifest of gemspecFiles) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(projectPath, manifest), 'utf8');
    } catch {
      continue;
    }
    const root = path.dirname(manifest);

    const executablesMatch = content.match(/executables\s*=\s*\[([^\]]*)\]/);
    if (executablesMatch) {
      for (const nameMatch of executablesMatch[1].matchAll(/['"]([^'"]+)['"]/g)) {
        out.push({
          root_path: root,
          name: nameMatch[1],
          tier: 2,
          kind: 'bin',
          evidence: [`gemspec executables: ${nameMatch[1]} (${manifest})`],
        });
      }
    }
  }

  let exeFiles: string[] = [];
  try {
    exeFiles = safeGlobSync('**/exe/*', { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    exeFiles = [];
  }
  for (const file of exeFiles) {
    const root = path.dirname(path.dirname(file));
    out.push({
      root_path: root === '' ? '.' : root,
      name: path.basename(file),
      tier: 2,
      kind: 'bin',
      evidence: [`exe/ executable: ${file}`],
    });
  }

  return out;
}


function collectPackageIdentity(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
  const out: DeployableEvidence[] = [];

  let gemspecFiles: string[] = [];
  try {
    gemspecFiles = safeGlobSync('*.gemspec', { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    gemspecFiles = [];
  }
  for (const manifest of gemspecFiles) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(projectPath, manifest), 'utf8');
    } catch {
      continue;
    }
    const name = content.match(/\.name\s*=\s*['"]([^'"]+)['"]/)?.[1];
    const version = content.match(/\.version\s*=\s*['"]([^'"]+)['"]/)?.[1];
    if (name) {
      out.push({
        root_path: '.',
        name,
        tier: 3,
        kind: 'package',
        evidence: [`${manifest} name: ${name}`, ...(version ? [`version: ${version}`] : [])],
      });
    }
  }

  const gemfilePath = path.join(projectPath, 'Gemfile');
  if (!gemspecFiles.length && fs.existsSync(gemfilePath)) {
    out.push({
      root_path: '.',
      name: safeDeployableName(displayName || path.basename(projectPath)),
      tier: 3,
      kind: 'package',
      evidence: [`Gemfile present: ${path.basename(gemfilePath)}`],
    });
  }

  return out;
}

function collect(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  return [
    ...collectRailsApp(ctx),
    ...collectRackup(ctx),
    ...collectGemExecutables(ctx),
    ...collectPackageIdentity(ctx),
  ];
}

export const rubyProvider: EvidenceProvider = {
  id: 'ruby',
  tier: 2,
  collect,
};
