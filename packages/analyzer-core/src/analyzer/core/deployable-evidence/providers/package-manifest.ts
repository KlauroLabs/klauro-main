import * as fs from 'fs-extra';
import * as path from 'path';
import type { DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { IGNORE_GLOBS, safeDeployableName, safeGlobSync } from '../util';

function collect(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  return safeGlobSync(['**/package.json', '**/Cargo.toml', '**/go.mod'], {
    cwd: ctx.projectPath,
    ignore: IGNORE_GLOBS,
    nodir: true,
    dot: false
  })
    .sort()
    .flatMap(relativePath => manifestEvidence(ctx, relativePath));
}

function manifestEvidence(ctx: EvidenceCollectionContext, relativePath: string): DeployableEvidence[] {
  const normalizedPath = relativePath.replace(/\\/g, '/');
  const rootPath = path.posix.dirname(normalizedPath);
  const fullPath = path.join(ctx.projectPath, relativePath);
  try {
    if (path.basename(relativePath) === 'package.json') {
      const manifest = fs.readJsonSync(fullPath);
      const fallback = rootPath === '.'
        ? ctx.displayName || path.basename(ctx.projectPath)
        : path.posix.basename(rootPath);
      return [{
        root_path: rootPath,
        name: manifest.name || safeDeployableName(fallback),
        tier: 3,
        kind: 'package',
        evidence: [
          `package.json name: ${manifest.name || '(unnamed)'}`,
          ...(manifest.version ? [`version: ${manifest.version}`] : []),
          ...(manifest.private ? ['private: true'] : [])
        ]
      }];
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    if (path.basename(relativePath) === 'Cargo.toml') return cargoManifestEvidence(rootPath, content);
    if (path.basename(relativePath) === 'go.mod') return goManifestEvidence(rootPath, content);
  } catch {
    return [];
  }
  return [];
}

function cargoManifestEvidence(rootPath: string, content: string): DeployableEvidence[] {
  const packageSection = content.match(/^\s*\[package\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m)?.[1] || '';
  const name = packageSection.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
  if (!name) return [];
  const version = packageSection.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
  return [{
    root_path: rootPath,
    name,
    tier: 3,
    kind: 'package',
    evidence: [`Cargo.toml name: ${name}`, ...(version ? [`version: ${version}`] : [])]
  }];
}

function goManifestEvidence(rootPath: string, content: string): DeployableEvidence[] {
  const moduleName = content.match(/^module\s+(\S+)/m)?.[1];
  return moduleName ? [{
    root_path: rootPath,
    name: moduleName,
    tier: 3,
    kind: 'package',
    evidence: [`go.mod module: ${moduleName}`]
  }] : [];
}

export const packageManifestProvider: EvidenceProvider = {
  id: 'package-manifest',
  tier: 3,
  collect
};
