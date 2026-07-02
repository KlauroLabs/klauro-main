import * as fs from 'fs-extra';
import * as path from 'path';
import type { DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';

/** package.json / Cargo.toml / go.mod as the publishable/installable unit identity. */
function collect(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath } = ctx;
  const out: DeployableEvidence[] = [];

  const packageJsonPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const json = fs.readJsonSync(packageJsonPath);
      out.push({
        root_path: '.',
        name: json.name || path.basename(projectPath),
        tier: 3,
        kind: 'package',
        evidence: [
          `package.json name: ${json.name || '(unnamed)'}`,
          ...(json.version ? [`version: ${json.version}`] : []),
          ...(json.private ? ['private: true'] : []),
        ],
      });
    } catch {
      // unreadable manifest contributes nothing
    }
  }

  const cargoTomlPath = path.join(projectPath, 'Cargo.toml');
  if (fs.existsSync(cargoTomlPath)) {
    try {
      const content = fs.readFileSync(cargoTomlPath, 'utf8');
      const name = content.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
      const version = content.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
      if (name) {
        out.push({
          root_path: '.',
          name,
          tier: 3,
          kind: 'package',
          evidence: [`Cargo.toml name: ${name}`, ...(version ? [`version: ${version}`] : [])],
        });
      }
    } catch {
      // unreadable manifest contributes nothing
    }
  }

  const goModPath = path.join(projectPath, 'go.mod');
  if (fs.existsSync(goModPath)) {
    try {
      const content = fs.readFileSync(goModPath, 'utf8');
      const module = content.match(/^module\s+(\S+)/m)?.[1];
      if (module) {
        out.push({
          root_path: '.',
          name: module,
          tier: 3,
          kind: 'package',
          evidence: [`go.mod module: ${module}`],
        });
      }
    } catch {
      // unreadable manifest contributes nothing
    }
  }

  return out;
}

export const packageManifestProvider: EvidenceProvider = {
  id: 'package-manifest',
  tier: 3,
  collect,
};
