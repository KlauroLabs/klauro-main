import * as fs from 'fs-extra';
import * as path from 'path';
import type { DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { IGNORE_GLOBS, safeDeployableName, safeGlobSync } from '../util';























function androidAppModuleName(
  gradleDir: string,
  manifestPath: string | undefined,
  projectPath: string,
  displayName?: string,
): string {



  if (manifestPath) {
    try {
      const manifestContent = fs.readFileSync(path.join(projectPath, manifestPath), 'utf8');
      const pkgMatch = manifestContent.match(/package\s*=\s*"([^"]+)"/);
      if (pkgMatch) return pkgMatch[1];
    } catch {

    }
  }







  if (displayName) return safeDeployableName(displayName);
  return path.basename(gradleDir) === '.' ? safeDeployableName(path.basename(projectPath)) : path.basename(gradleDir);
}

















function isPluginApplied(content: string, pluginId: string): boolean {
  const escaped = pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declarationRegexes = [
    new RegExp(`\\bid\\s*\\(\\s*["']${escaped}["']\\s*\\)([^\\n]*)`, 'g'),
    new RegExp(`\\bid\\s+["']${escaped}["']([^\\n]*)`, 'g'),
  ];
  for (const regex of declarationRegexes) {
    for (const match of content.matchAll(regex)) {
      if (!/\bapply\s+false\b/.test(match[1] || '')) return true;
    }
  }
  return new RegExp(`apply\\s+plugin:\\s*['"]${escaped}['"]`).test(content);
}





function findEnclosingSettingsFile(projectPath: string, gradleDir: string): string | undefined {
  let dir = gradleDir;
  while (true) {
    for (const name of ['settings.gradle.kts', 'settings.gradle']) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(path.join(projectPath, candidate))) return candidate;
    }
    if (dir === '.' || dir === '') break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}







function parseIncludedGradleModules(content: string): string[] {
  const modules = new Set<string>();
  for (const call of content.matchAll(/include\s*\(([^)]*)\)|include\s+((?:['"][^'"]*['"]\s*,?\s*)+)/g)) {
    const args = call[1] ?? call[2] ?? '';
    for (const m of args.matchAll(/['"]:?([^'":]+)['"]/g)) {
      const segments = m[1].split(':').filter(Boolean);
      if (segments.length) modules.add(segments[segments.length - 1]);
    }
  }
  return [...modules];
}






















function rootAggregatorShipsPaths(
  projectPath: string,
  gradleDir: string,
  displayName: string | undefined,
): string[] | undefined {
  const moduleBase = path.basename(gradleDir);
  const tokens = new Set<string>();
  if (gradleDir !== '.') tokens.add(moduleBase);

  const settingsFile = findEnclosingSettingsFile(projectPath, gradleDir);
  if (!settingsFile) return tokens.size ? [...tokens] : undefined;

  let settingsContent = '';
  try {
    settingsContent = fs.readFileSync(path.join(projectPath, settingsFile), 'utf8');
  } catch {
    return tokens.size ? [...tokens] : undefined;
  }

  const includedModules = parseIncludedGradleModules(settingsContent);
  const isIncluded = gradleDir === '.' || includedModules.some(m => m.toLowerCase() === moduleBase.toLowerCase());
  if (!isIncluded) return tokens.size ? [...tokens] : undefined;

  const rootProjectNameMatch = settingsContent.match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/);
  if (rootProjectNameMatch) tokens.add(rootProjectNameMatch[1]);
  if (displayName) tokens.add(displayName);

  return tokens.size ? [...tokens] : undefined;
}

function collectAndroid(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
  const out: DeployableEvidence[] = [];

  let gradleFiles: string[] = [];
  try {
    gradleFiles = safeGlobSync(['**/build.gradle', '**/build.gradle.kts'], {
      cwd: projectPath,
      ignore: IGNORE_GLOBS,
      nodir: true,
      absolute: false,
    });
  } catch {
    gradleFiles = [];
  }

  for (const gradleFile of gradleFiles) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(projectPath, gradleFile), 'utf8');
    } catch {
      continue;
    }
    const gradleDir = path.dirname(gradleFile);

    const isApp = isPluginApplied(content, 'com.android.application');
    const isLib = isPluginApplied(content, 'com.android.library');
    if (!isApp && !isLib) continue;

    let manifestPath: string | undefined;
    const candidateManifest = path.join(gradleDir, 'src', 'main', 'AndroidManifest.xml');
    if (fs.existsSync(path.join(projectPath, candidateManifest))) manifestPath = candidateManifest;

    let hasLauncherActivity = false;
    if (manifestPath) {
      try {
        const manifestContent = fs.readFileSync(path.join(projectPath, manifestPath), 'utf8');
        hasLauncherActivity =
          /android\.intent\.action\.MAIN/.test(manifestContent) && /android\.intent\.category\.LAUNCHER/.test(manifestContent);
      } catch {
        hasLauncherActivity = false;
      }
    }

    if (isApp) {
      const name = androidAppModuleName(gradleDir, manifestPath, projectPath, displayName);
      const evidence = [`build.gradle applies com.android.application (${gradleFile}) — the APK/AAB is the ship unit for Android`];
      if (manifestPath) evidence.push(`AndroidManifest.xml: ${manifestPath}`);
      if (hasLauncherActivity) evidence.push('AndroidManifest.xml declares a MAIN/LAUNCHER activity');
      const shipsPaths = rootAggregatorShipsPaths(projectPath, gradleDir, displayName);
      if (shipsPaths) {
        evidence.push(
          `settings/root Gradle files describing this same module tree (${shipsPaths.join(', ')}) roll up into this ship unit`,
        );
      }
      out.push({
        root_path: gradleDir,
        name,
        tier: 1,
        kind: 'bin',
        evidence,
        ships_paths: shipsPaths,
      });
    } else if (isLib) {
      out.push({
        root_path: gradleDir,
        name: path.basename(gradleDir) === '.' ? safeDeployableName(displayName || path.basename(projectPath)) : path.basename(gradleDir),
        tier: 3,
        kind: 'package',
        evidence: [`build.gradle applies com.android.library (${gradleFile})`],
      });
    }
  }

  return out;
}



function collectXcode(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath } = ctx;
  const out: DeployableEvidence[] = [];

  let pbxprojFiles: string[] = [];
  try {
    pbxprojFiles = safeGlobSync('**/*.xcodeproj/project.pbxproj', {
      cwd: projectPath,
      ignore: IGNORE_GLOBS,
      nodir: true,
      absolute: false,
    });
  } catch {
    pbxprojFiles = [];
  }

  for (const pbxprojFile of pbxprojFiles) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(projectPath, pbxprojFile), 'utf8');
    } catch {
      continue;
    }
    const rootPath = path.dirname(path.dirname(pbxprojFile));








    for (const match of content.matchAll(/isa\s*=\s*PBXNativeTarget;([\s\S]*?)\};/g)) {
      const block = match[1];
      const nameMatch = block.match(/\bname\s*=\s*"?([^;"\n]+)"?;/);
      const productTypeMatch = block.match(/productType\s*=\s*"([^"]+)"/);
      if (!nameMatch || !productTypeMatch) continue;
      const name = nameMatch[1].trim();
      const productType = productTypeMatch[1];

      if (productType === 'com.apple.product-type.application') {
        out.push({
          root_path: rootPath,
          name,
          tier: 1,
          kind: 'bin',
          evidence: [`Xcode PBXNativeTarget "${name}" productType=application (${pbxprojFile}) — the .ipa/App Store bundle is the ship unit for iOS`],
        });
      } else if (/com\.apple\.product-type\.(framework|library|static)/.test(productType)) {
        out.push({
          root_path: rootPath,
          name,
          tier: 3,
          kind: 'package',
          evidence: [`Xcode PBXNativeTarget "${name}" productType=${productType} (${pbxprojFile})`],
        });
      }
    }
  }

  return out;
}


function collectSwiftPackage(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath } = ctx;
  const out: DeployableEvidence[] = [];

  let manifests: string[] = [];
  try {
    manifests = safeGlobSync('**/Package.swift', { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    manifests = [];
  }

  for (const manifest of manifests) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(projectPath, manifest), 'utf8');
    } catch {
      continue;
    }
    const rootPath = path.dirname(manifest);

    for (const match of content.matchAll(/\.executableTarget\s*\(\s*name\s*:\s*"([^"]+)"/g)) {
      out.push({
        root_path: rootPath,
        name: match[1],
        tier: 1,
        kind: 'bin',
        evidence: [`Package.swift .executableTarget(name: "${match[1]}") (${manifest}) — the build TARGET is the ship unit for SwiftPM executables`],
      });
    }


    for (const match of content.matchAll(/\.library\s*\(\s*name\s*:\s*"([^"]+)"/g)) {
      out.push({
        root_path: rootPath,
        name: match[1],
        tier: 3,
        kind: 'package',
        evidence: [`Package.swift .library(name: "${match[1]}") (${manifest})`],
      });
    }
  }

  return out;
}



function collectPodfileIdentity(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
  const out: DeployableEvidence[] = [];
  const podfilePath = path.join(projectPath, 'Podfile');
  if (fs.existsSync(podfilePath)) {
    out.push({
      root_path: '.',
      name: safeDeployableName(displayName || path.basename(projectPath)),
      tier: 3,
      kind: 'package',
      evidence: ['Podfile present'],
    });
  }
  return out;
}

function collect(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  return [...collectAndroid(ctx), ...collectXcode(ctx), ...collectSwiftPackage(ctx), ...collectPodfileIdentity(ctx)];
}

export const mobileProvider: EvidenceProvider = {
  id: 'mobile',
  tier: 1,
  collect,
};
