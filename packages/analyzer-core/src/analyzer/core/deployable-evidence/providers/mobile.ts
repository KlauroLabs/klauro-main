import * as fs from 'fs-extra';
import * as path from 'path';
import type { DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { IGNORE_GLOBS, safeDeployableName, safeGlobSync } from '../util';

/**
 * Mobile (Android + iOS) evidence provider.
 *
 * SHIP-UNIT NOTE (mobile ecosystems): like native C/C++ builds, mobile app
 * modules rarely ship behind a repo-level Dockerfile/compose/k8s manifest —
 * the APK/AAB (Android) or the .ipa/App Store bundle (iOS) built from the
 * app module/app target IS the ship artifact, with no separate ship-
 * declaration file for this provider to point at. So an Android module
 * carrying the `com.android.application` Gradle plugin, or an iOS Xcode app
 * target / SwiftPM `executableTarget`, is treated here as TIER 1 'bin'
 * evidence (reusing the existing 'bin' kind, same reasoning as native.ts) —
 * this ensures the shared resolver's shipped-gate (apps/mcp-server/src/
 * cross-codebase-analysis.ts applyShippedGate) does not demote a bare
 * Android app module (or iOS app target) to deployable:false just because no
 * Dockerfile exists anywhere in the repo, e.g. a repo with only an app
 * module + a library module and zero containers must still surface the app
 * module as the deployable. `com.android.library` modules and SwiftPM
 * `.library` targets remain tier-3 'package' evidence only — they roll up as
 * shared code and are never their own deployable, matching add_library in
 * native.ts.
 */

function androidAppModuleName(
  gradleDir: string,
  manifestPath: string | undefined,
  projectPath: string,
  displayName?: string,
): string {
  // settings.gradle(.kts) `include ':name'` mapping would be the most precise
  // name, but module directory name is a solid, simple identity fallback
  // consistent with how other providers (bin-targets.ts src/bin/*) name by dir.
  if (manifestPath) {
    try {
      const manifestContent = fs.readFileSync(path.join(projectPath, manifestPath), 'utf8');
      const pkgMatch = manifestContent.match(/package\s*=\s*"([^"]+)"/);
      if (pkgMatch) return pkgMatch[1];
    } catch {
      // fall through to dir name
    }
  }
  return path.basename(gradleDir) === '.' ? safeDeployableName(displayName || path.basename(projectPath)) : path.basename(gradleDir);
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

    const isApp = /com\.android\.application/.test(content);
    const isLib = /com\.android\.library/.test(content);
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
      out.push({
        root_path: gradleDir,
        name,
        tier: 1,
        kind: 'bin',
        evidence,
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

/** Xcode project app targets: parse the .pbxproj for PBXNativeTarget entries
 *  whose productType is application vs. framework/library. */
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

    // Each PBXNativeTarget block roughly looks like:
    //   XXXXXXXX /* Name */ = {
    //     isa = PBXNativeTarget;
    //     ...
    //     name = Name;
    //     productType = "com.apple.product-type.application";
    //   };
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

/** Swift Package Manager: Package.swift executableTarget (bin) vs. .library (package). */
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

    // .library(name: "X", targets: [...]) — the product identity; roll up as package.
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

/** Podfile presence: tier-3 package identity for CocoaPods-managed libraries/apps
 *  that have no Xcode/SwiftPM signal picked up above. */
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
