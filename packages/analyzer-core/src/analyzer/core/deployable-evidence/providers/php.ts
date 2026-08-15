import * as fs from 'fs-extra';
import * as path from 'path';
import type { DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { arrayOf, IGNORE_GLOBS, safeDeployableName, safeGlobSync } from '../util';


function collectFrontController(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
  const out: DeployableEvidence[] = [];
  let files: string[] = [];
  try {
    files = safeGlobSync('**/public/index.php', { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    files = [];
  }
  for (const file of files) {

    const root = path.dirname(path.dirname(file));
    out.push({
      root_path: root === '' ? '.' : root,
      name: path.basename(root) === '.' || root === '' ? safeDeployableName(displayName || path.basename(projectPath)) : path.basename(root),
      tier: 2,
      kind: 'server-entry',
      evidence: [`front controller: ${file}`],
    });
  }
  return out;
}


function collectLaravel(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
  const out: DeployableEvidence[] = [];
  let files: string[] = [];
  try {
    files = safeGlobSync('**/artisan', { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    files = [];
  }
  for (const file of files) {
    const root = path.dirname(file);
    const name = path.basename(root) === '.' ? safeDeployableName(displayName || path.basename(projectPath)) : path.basename(root);
    out.push({
      root_path: root === '' ? '.' : root,
      name,
      tier: 2,
      kind: 'server-entry',
      evidence: [`Laravel artisan: ${file}`],
    });
    out.push({
      root_path: root === '' ? '.' : root,
      name,
      tier: 2,
      kind: 'bin',
      evidence: [`Laravel artisan console: ${file}`],
    });
  }
  return out;
}


function collectComposerBin(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath } = ctx;
  const out: DeployableEvidence[] = [];
  let manifests: string[] = [];
  try {
    manifests = safeGlobSync('**/composer.json', { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    manifests = [];
  }
  for (const manifest of manifests) {
    let json: any;
    try {
      json = fs.readJsonSync(path.join(projectPath, manifest));
    } catch {
      continue;
    }
    const bins = arrayOf(json.bin);
    const root = path.dirname(manifest);
    for (const binPath of bins) {
      out.push({
        root_path: root,
        name: path.basename(binPath),
        tier: 2,
        kind: 'bin',
        evidence: [`composer.json bin: "${binPath}" (${manifest})`],
      });
    }
  }
  return out;
}


function collectPackageIdentity(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
  const out: DeployableEvidence[] = [];
  const composerJsonPath = path.join(projectPath, 'composer.json');
  if (fs.existsSync(composerJsonPath)) {
    try {
      const json = fs.readJsonSync(composerJsonPath);
      out.push({
        root_path: '.',
        name: json.name || safeDeployableName(displayName || path.basename(projectPath)),
        tier: 3,
        kind: 'package',
        evidence: [
          `composer.json name: ${json.name || '(unnamed)'}`,
          ...(json.version ? [`version: ${json.version}`] : []),
        ],
      });
    } catch {

    }
  }
  return out;
}

function collect(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  return [
    ...collectLaravel(ctx),
    ...collectFrontController(ctx),
    ...collectComposerBin(ctx),
    ...collectPackageIdentity(ctx),
  ];
}

export const phpProvider: EvidenceProvider = {
  id: 'php',
  tier: 2,
  collect,
};
