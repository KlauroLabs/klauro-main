import * as fs from 'fs-extra';
import * as path from 'path';
import type { DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { IGNORE_GLOBS, safeDeployableName, safeGlobSync } from '../util';

/**
 * Desktop packaging-plugin evidence: electron-builder (and its close cousin
 * electron-forge) config files are the packaging-tool equivalent of a
 * Dockerfile COPY/ENTRYPOINT or a `spring-boot-maven-plugin repackage` goal —
 * a real ship/run artifact declaration, not a folder-name guess. Doctrine
 * (SPEC-DEPLOYABLE-DETECTION.md): deployable boundaries come from evidence
 * like this, never from "the repo mentions electron" or a directory named
 * `desktop/`.
 *
 * electron-builder's own config filename convention
 * (electron-builder.{yml,yaml,json,json5,toml,config.js,config.cjs,
 * config.mjs,config.ts}) is unambiguous positive evidence on its own — same
 * class of signal as docker-compose.yml or Cargo.toml naming the tool that
 * reads it, not a name a project author picked incidentally. electron-forge's
 * config (forge.config.js/cjs/mjs/ts, or a "config.forge" key in
 * package.json) gets the same treatment. Both tools produce installable
 * desktop artifacts (.dmg/.exe/.deb/.AppImage/...) from a `make`/`build`
 * step, so this is TIER 1 'installer' evidence — the packaging config itself
 * IS the ship declaration, the same way a Dockerfile's COPY/ENTRYPOINT is.
 */

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

/** Extract `productName`/`appId` from a YAML/JSON/JSON5/TOML/JS config body
 *  without a full parser for every format — all of them share the same
 *  `key: value` / `key = value` / `"key": "value"` shape for these two
 *  top-level scalar fields, which is all this needs. */
function extractScalarField(content: string, field: string): string | undefined {
  // Covers YAML (`productName: MyApp` or `productName: "MyApp"`), JSON/JSON5
  // (`"productName": "MyApp"`), TOML (`productName = "MyApp"`), and JS/TS
  // config objects (`productName: 'MyApp'`) with one pattern: an optionally
  // quoted key, a `:`/`=` separator, then either a quoted value or a bare
  // unquoted scalar run to end-of-line (YAML's common unquoted-string form).
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

  // electron-builder also reads a `"build"` object straight out of
  // package.json when no standalone config file exists. Only treat that as
  // evidence when it is co-located with the `electron-builder` package
  // itself (devDependencies/dependencies) — an arbitrary `build` key with no
  // electron-builder dependency is not positive evidence of this tool.
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
      // unreadable/unparseable package.json contributes nothing here
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
      evidence: [
        'electron-builder "build" config in package.json (electron-builder present in dependencies)',
        ...(productName ? [`productName: ${productName}`] : []),
        ...(appId ? [`appId: ${appId}`] : []),
      ],
    });
  }

  return out;
}

/** electron-forge: forge.config.{js,cjs,mjs,ts}, or a `"config": { "forge":
 *  ... }` block in package.json — only counted when the `@electron-forge/*`
 *  tooling itself is a dependency, for the same positive-evidence reason as
 *  electron-builder's package.json fallback above. */
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
          evidence: ['electron-forge "config.forge" in package.json (@electron-forge tooling present in dependencies)'],
        });
      }
    } catch {
      // unreadable/unparseable package.json contributes nothing here
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
