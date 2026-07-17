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
  // Prefer the resolved display name (ctx.displayName) over a bare module
  // directory basename ('app') for the SHIP unit — a directory name is a
  // dir-shaped label, never the product's real identity, and the module dir
  // is frequently just the generic Android Studio default ('app') that tells
  // an agent/reader nothing. This only applies to the actual application
  // module (this function is only called from the isApp branch below);
  // library modules keep their own directory-derived name.
  if (displayName) return safeDeployableName(displayName);
  return path.basename(gradleDir) === '.' ? safeDeployableName(path.basename(projectPath)) : path.basename(gradleDir);
}

/** True when `content` actually APPLIES `pluginId` in this module, as
 *  opposed to merely DECLARING/pinning it for subprojects. Modern Android
 *  Gradle Plugin projects put every subproject plugin in the ROOT
 *  build.gradle(.kts) with `apply false`:
 *    plugins {
 *      id("com.android.application") version "8.2.0" apply false
 *      id("com.android.library") version "8.2.0" apply false
 *    }
 *  A naive substring test against `com.android.application` matches this
 *  root declaration too, minting a phantom Android-app ship unit at the repo
 *  root for the standard single/multi-module Android Studio template — the
 *  root project itself never applies the plugin, it only version-pins it for
 *  whichever module (`app/build.gradle.kts`) actually applies it without a
 *  version. Real application happens via `id("<pluginId>")` /
 *  `id '<pluginId>'` / `apply plugin: '<pluginId>'` NOT immediately
 *  qualified by `apply false` on the same declaration. */
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

/** Walk from `gradleDir` up toward the repo root looking for the nearest
 *  settings.gradle(.kts) — mirrors jvm.ts's nearestModuleRoot walk-up
 *  pattern, kept local since this file doesn't import from jvm.ts (providers
 *  stay independent/pure). */
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

/** Module tokens a settings.gradle(.kts) `include(...)` declares, e.g.
 *  `include(":app")` / `include ':app', ':lib'` -> ['app', 'lib']. Handles
 *  both Groovy and Kotlin DSL, single- or multi-argument `include(...)`. Only
 *  the final path segment is kept (Gradle's `:feature:app` still maps to a
 *  directory named `app`), matching how deployable-evidence.ts's
 *  evidenceNameMatchesShippedToken already compares by basename. */
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

/**
 * Positive containment evidence for the "one ship unit, not five sibling
 * rows" fix (SPEC-DEPLOYABLE-DETECTION.md merge doctrine): a repo-root
 * build.gradle(.kts) and settings.gradle(.kts) are workspace-aggregator
 * artifacts, not distinct shipped things, when they describe the SAME module
 * tree as this Android app module — jvm.ts's generic Tier-3 package-identity
 * scan (every build.gradle(.kts)/settings.gradle(.kts) in the repo) still
 * emits a row for each of them (root build file, this module's build file,
 * the settings file), independent of ecosystem. Rather than teach the
 * generic evidence-bundling pass Gradle-specific parsing, this reads the
 * enclosing settings.gradle(.kts) directly, confirms it actually
 * `include`s THIS module (never on path-ancestry/name-similarity alone —
 * requires the settings file's declared module list to name this
 * directory), and returns the exact name tokens (module dir basename,
 * declared `rootProject.name`, and the resolved display name) those sibling
 * Tier-3 rows are named with. Populating this app unit's `ships_paths` with
 * those tokens lets the EXISTING generic `resolveEvidenceBundling` pass in
 * deployable-evidence.ts (originally built for Dockerfile/installer member
 * lists) fold them in via `bundled_into`, with zero Gradle-specific code
 * needed in the shared cross-provider merge layer.
 */
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
  if (!isIncluded) return tokens.size ? [...tokens] : undefined; // no positive containment evidence -> don't guess

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
