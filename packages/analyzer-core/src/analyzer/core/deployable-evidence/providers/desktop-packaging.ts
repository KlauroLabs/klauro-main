import * as fs from 'fs-extra';
import * as path from 'path';
import type { DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { IGNORE_GLOBS, safeDeployableName, safeGlobSync } from '../util';






















const ELECTRON_BUILDER_CONFIG_GLOBS = [
  'electron-builder.yml',
  'electron-builder.yaml',
  'electron-builder.json',
  'electron-builder.json5',
  'electron-builder.toml',
  'electron-builder.config.js',
  'electron-builder.config.cjs',
  'electron-builder.config.mjs',
  'electron-builder.config.ts',
];

const ELECTRON_FORGE_CONFIG_GLOBS = [
  'forge.config.js',
  'forge.config.cjs',
  'forge.config.mjs',
  'forge.config.ts',
];

function readFileSafe(projectPath: string, relFile: string): string | undefined {
  try {
    return fs.readFileSync(path.join(projectPath, relFile), 'utf8');
  } catch {
    return undefined;
  }
}





function extractScalarField(content: string, field: string): string | undefined {





  const match = content.match(
    new RegExp(`["']?${field}["']?\\s*[:=]\\s*(?:["']([^"']+)["']|([^\\n,}]+))`)
  );
  const value = (match?.[1] ?? match?.[2])?.trim();
  return value || undefined;
}

function extractProductIdentity(content: string): { productName?: string; appId?: string } {
  return {
    productName: extractScalarField(content, 'productName'),
    appId: extractScalarField(content, 'appId'),
  };
}

function collectElectronBuilder(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
  const out: DeployableEvidence[] = [];

  let configFiles: string[] = [];
  try {
    configFiles = safeGlobSync(ELECTRON_BUILDER_CONFIG_GLOBS, { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    configFiles = [];
  }






  const packageJsonPath = path.join(projectPath, 'package.json');
  let packageJsonBuildEvidence: { rootPath: string; productName?: string; appId?: string } | undefined;
  if (configFiles.length === 0 && fs.existsSync(packageJsonPath)) {
    try {
      const json = fs.readJsonSync(packageJsonPath);
      const deps = { ...(json.dependencies || {}), ...(json.devDependencies || {}) };
      if (deps['electron-builder'] && json.build && typeof json.build === 'object') {
        packageJsonBuildEvidence = {
          rootPath: '.',
          productName: typeof json.build.productName === 'string' ? json.build.productName : undefined,
          appId: typeof json.build.appId === 'string' ? json.build.appId : undefined,
        };
      }
    } catch {

    }
  }

  for (const configFile of configFiles) {
    const content = readFileSafe(projectPath, configFile);
    if (content === undefined) continue;
    const { productName, appId } = extractProductIdentity(content);
    const rootPath = path.dirname(configFile);
    const name = productName || appId || safeDeployableName(displayName || path.basename(projectPath));

    out.push({
      root_path: rootPath,
      name,
      tier: 1,
      kind: 'installer',
      entry_files: [configFile],
      evidence: [
        `electron-builder config: ${configFile}`,
        ...(productName ? [`productName: ${productName}`] : []),
        ...(appId ? [`appId: ${appId}`] : []),
      ],
    });
  }

  if (packageJsonBuildEvidence) {
    const { rootPath, productName, appId } = packageJsonBuildEvidence;
    out.push({
      root_path: rootPath,
      name: productName || appId || safeDeployableName(displayName || path.basename(projectPath)),
      tier: 1,
      kind: 'installer',
      entry_files: ['package.json'],
      evidence: [
        'electron-builder "build" config in package.json (electron-builder present in dependencies)',
        ...(productName ? [`productName: ${productName}`] : []),
        ...(appId ? [`appId: ${appId}`] : []),
      ],
    });
  }

  return out;
}





function collectElectronForge(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
  const out: DeployableEvidence[] = [];

  let configFiles: string[] = [];
  try {
    configFiles = safeGlobSync(ELECTRON_FORGE_CONFIG_GLOBS, { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    configFiles = [];
  }

  for (const configFile of configFiles) {
    const content = readFileSafe(projectPath, configFile);
    if (content === undefined) continue;
    const rootPath = path.dirname(configFile);
    out.push({
      root_path: rootPath,
      name: safeDeployableName(displayName || path.basename(projectPath)),
      tier: 1,
      kind: 'installer',
      entry_files: [configFile],
      evidence: [`electron-forge config: ${configFile}`],
    });
  }

  const packageJsonPath = path.join(projectPath, 'package.json');
  if (configFiles.length === 0 && fs.existsSync(packageJsonPath)) {
    try {
      const json = fs.readJsonSync(packageJsonPath);
      const deps = { ...(json.dependencies || {}), ...(json.devDependencies || {}) };
      const hasForgeDep = Object.keys(deps).some(dep => dep.startsWith('@electron-forge/'));
      if (hasForgeDep && json.config && typeof json.config === 'object' && json.config.forge) {
        out.push({
          root_path: '.',
          name: safeDeployableName(displayName || path.basename(projectPath)),
          tier: 1,
          kind: 'installer',
          entry_files: ['package.json'],
          evidence: ['electron-forge "config.forge" in package.json (@electron-forge tooling present in dependencies)'],
        });
      }
    } catch {

    }
  }

  return out;
}

function collect(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  return [...collectElectronBuilder(ctx), ...collectElectronForge(ctx)];
}

export const desktopPackagingProvider: EvidenceProvider = {
  id: 'desktop-packaging',
  tier: 1,
  collect,
};
