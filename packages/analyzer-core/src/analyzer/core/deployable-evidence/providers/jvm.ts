import * as fs from 'fs-extra';
import * as path from 'path';
import type { DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { IGNORE_GLOBS, safeDeployableName, safeGlobSync } from '../util';

/**
 * JVM ecosystem (Java/Kotlin, Gradle/Maven, Spring Boot) deployable evidence.
 *
 * Tier 2 (runnable entry):
 *  - Spring Boot: `@SpringBootApplication` class with `public static void
 *    main(String[] args)` -> kind 'server-entry'.
 *  - Gradle `application` plugin / `mainClass` (build.gradle or
 *    build.gradle.kts, top-level `application { mainClass = ... }` or the
 *    legacy `mainClassName` property) -> kind 'bin' (or 'server-entry' when
 *    the module also looks like Spring Boot).
 *  - Maven `spring-boot-maven-plugin` or `maven-shade-plugin`/`assembly`
 *    mainClass in pom.xml -> kind 'server-entry'.
 *  - Any bare `public static void main(String[]` / `public static void
 *    main(String... args)` Java/Kotlin source not already claimed above
 *    -> kind 'bin'.
 *
 * Tier 3 (package identity):
 *  - pom.xml / build.gradle / build.gradle.kts / settings.gradle(.kts) as a
 *    'package' candidate (module or workspace identity), independent of
 *    whether the module is runnable — this is what lets a library module
 *    (no main, no application plugin) still surface as a non-deployable
 *    package that later rolls up under a parent app.
 *
 * Multi-module awareness: Gradle/Maven multi-module builds are walked by
 * globbing every build.gradle(.kts)/pom.xml in the tree, so each submodule
 * is evaluated independently — a submodule with its own Spring Boot main is
 * its own Tier-2 candidate at that submodule's root_path, while a sibling
 * library submodule (no main, no application plugin) only contributes a
 * Tier-3 package candidate. The evidence-gated deployable resolver decides
 * top-level vs. rolled-up from there (see cross-codebase-analysis.ts).
 */

const BUILD_GRADLE_GLOBS = ['**/build.gradle', '**/build.gradle.kts'];
const SETTINGS_GRADLE_GLOBS = ['**/settings.gradle', '**/settings.gradle.kts'];
const POM_GLOB = '**/pom.xml';
const JAVA_KOTLIN_SOURCE_GLOBS = ['**/*.java', '**/*.kt'];

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

function moduleNameFromRoot(rootPath: string, projectPath: string, displayName?: string): string {
  if (rootPath === '.' || rootPath === '') return safeDeployableName(displayName || path.basename(projectPath));
  return path.basename(rootPath);
}

/** Spring Boot: `@SpringBootApplication` + `public static void main` in the same source file. */
function collectSpringBootApplications(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
  const out: DeployableEvidence[] = [];
  const sources = globSafe(projectPath, JAVA_KOTLIN_SOURCE_GLOBS);

  for (const file of sources) {
    const content = readFileSafe(projectPath, file);
    if (!content) continue;
    if (!/@SpringBootApplication\b/.test(content)) continue;
    const hasMain = /public\s+static\s+void\s+main\s*\(\s*String(\[\]|\.\.\.)/.test(content);
    if (!hasMain) continue;

    // root_path: walk up from the source file to the nearest build file
    // (build.gradle(.kts) or pom.xml) so the module's evidence lands at the
    // module root rather than deep inside src/main/java/....
    const rootPath = nearestModuleRoot(projectPath, file);
    const className = path.basename(file, path.extname(file));

    out.push({
      root_path: rootPath,
      name: moduleNameFromRoot(rootPath, projectPath, displayName) || className,
      tier: 2,
      kind: 'server-entry',
      evidence: [
        `@SpringBootApplication + public static void main: ${file}`,
      ],
    });
  }

  return out;
}

/** Walk upward from a source file toward the project root looking for the nearest build.gradle(.kts)/pom.xml, defaulting to '.'. */
function nearestModuleRoot(projectPath: string, sourceFile: string): string {
  let dir = path.dirname(sourceFile);
  const seen: string[] = [];
  while (true) {
    seen.push(dir);
    const hasBuildFile =
      fs.existsSync(path.join(projectPath, dir, 'build.gradle')) ||
      fs.existsSync(path.join(projectPath, dir, 'build.gradle.kts')) ||
      fs.existsSync(path.join(projectPath, dir, 'pom.xml'));
    if (hasBuildFile) return dir;
    const parent = path.dirname(dir);
    if (parent === dir || dir === '.') break;
    dir = parent;
  }
  return '.';
}

/** Gradle `application` plugin with `mainClass`/`mainClassName`, per build.gradle(.kts) module. */
function collectGradleApplicationTargets(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
  const out: DeployableEvidence[] = [];
  const buildFiles = globSafe(projectPath, BUILD_GRADLE_GLOBS);

  for (const buildFile of buildFiles) {
    const content = readFileSafe(projectPath, buildFile);
    if (!content) continue;
    const hasApplicationPlugin = /(?:^|\s)id\s*[('"]application['")]|apply\s+plugin:\s*['"]application['"]/m.test(content)
      || /^\s*application\s*\{/m.test(content);
    if (!hasApplicationPlugin) continue;

    const mainClassMatch =
      content.match(/mainClass(?:Name)?\.set\(\s*['"]([^'"]+)['"]\s*\)/) ||
      content.match(/mainClass(?:Name)?\s*=\s*['"]([^'"]+)['"]/);
    const isSpringBoot = /(?:^|\s)id\s*[('"]org\.springframework\.boot['")]|spring-boot-gradle-plugin/m.test(content);
    const rootPath = path.dirname(buildFile);

    out.push({
      root_path: rootPath,
      name: moduleNameFromRoot(rootPath, projectPath, displayName),
      tier: 2,
      kind: isSpringBoot ? 'server-entry' : 'bin',
      evidence: [
        `Gradle application plugin (${buildFile})`,
        ...(mainClassMatch ? [`mainClass: ${mainClassMatch[1]}`] : []),
        ...(isSpringBoot ? ['org.springframework.boot gradle plugin present'] : []),
      ],
    });
  }

  return out;
}

/** Maven `spring-boot-maven-plugin` or shade/assembly mainClass in pom.xml, per pom.xml module. */
function collectMavenRunnableTargets(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
  const out: DeployableEvidence[] = [];
  const poms = globSafe(projectPath, POM_GLOB);

  for (const pom of poms) {
    const content = readFileSafe(projectPath, pom);
    if (!content) continue;
    const rootPath = path.dirname(pom);

    const hasSpringBootPlugin = /<artifactId>\s*spring-boot-maven-plugin\s*<\/artifactId>/.test(content);
    const shadeMainClassMatch = content.match(/<artifactId>\s*maven-shade-plugin\s*<\/artifactId>[\s\S]*?<mainClass>([^<]+)<\/mainClass>/)
      || content.match(/<artifactId>\s*maven-assembly-plugin\s*<\/artifactId>[\s\S]*?<mainClass>([^<]+)<\/mainClass>/);
    const execMainClassMatch = content.match(/<artifactId>\s*exec-maven-plugin\s*<\/artifactId>[\s\S]*?<mainClass>([^<]+)<\/mainClass>/);
    const bareMainClassMatch = !hasSpringBootPlugin && !shadeMainClassMatch && !execMainClassMatch
      ? content.match(/<mainClass>([^<]+)<\/mainClass>/)
      : undefined;

    if (!hasSpringBootPlugin && !shadeMainClassMatch && !execMainClassMatch && !bareMainClassMatch) continue;

    const mainClass = shadeMainClassMatch?.[1] || execMainClassMatch?.[1] || bareMainClassMatch?.[1];
    out.push({
      root_path: rootPath,
      name: moduleNameFromRoot(rootPath, projectPath, displayName),
      tier: 2,
      kind: hasSpringBootPlugin ? 'server-entry' : 'bin',
      evidence: [
        `pom.xml: ${pom}`,
        ...(hasSpringBootPlugin ? ['spring-boot-maven-plugin present'] : []),
        ...(mainClass ? [`mainClass: ${mainClass}`] : []),
      ],
    });
  }

  return out;
}

/** Any bare `public static void main` in a .java/.kt file not already claimed as Spring Boot. */
function collectBareMainMethods(ctx: EvidenceCollectionContext, alreadyClaimed: Set<string>): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
  const out: DeployableEvidence[] = [];
  const sources = globSafe(projectPath, JAVA_KOTLIN_SOURCE_GLOBS);

  for (const file of sources) {
    const content = readFileSafe(projectPath, file);
    if (!content) continue;
    if (/@SpringBootApplication\b/.test(content)) continue; // handled by collectSpringBootApplications
    const hasMain =
      /public\s+static\s+void\s+main\s*\(\s*String(\[\]|\.\.\.)/.test(content) || // Java
      /fun\s+main\s*\(/.test(content); // Kotlin top-level main
    if (!hasMain) continue;

    const rootPath = nearestModuleRoot(projectPath, file);
    const dedupeKey = `${rootPath}`;
    if (alreadyClaimed.has(dedupeKey)) continue; // module already has a Tier-2 candidate from Gradle/Maven scan

    const className = path.basename(file, path.extname(file));
    out.push({
      root_path: rootPath,
      name: moduleNameFromRoot(rootPath, projectPath, displayName) || className,
      tier: 2,
      kind: 'bin',
      evidence: [`main method: ${file}`],
    });
    alreadyClaimed.add(dedupeKey);
  }

  return out;
}

/** Tier 3: pom.xml / build.gradle(.kts) / settings.gradle(.kts) as package identity, per module. */
function collectPackageIdentity(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
  const out: DeployableEvidence[] = [];

  const poms = globSafe(projectPath, POM_GLOB);
  for (const pom of poms) {
    const content = readFileSafe(projectPath, pom);
    if (!content) continue;
    const artifactIdMatch = content.match(/<artifactId>([^<]+)<\/artifactId>/);
    const versionMatch = content.match(/<version>([^<]+)<\/version>/);
    const rootPath = path.dirname(pom);
    out.push({
      root_path: rootPath,
      name: artifactIdMatch?.[1] || moduleNameFromRoot(rootPath, projectPath, displayName),
      tier: 3,
      kind: 'package',
      evidence: [
        `pom.xml artifactId: ${artifactIdMatch?.[1] || '(unnamed)'}`,
        ...(versionMatch ? [`version: ${versionMatch[1]}`] : []),
      ],
    });
  }

  const buildFiles = globSafe(projectPath, BUILD_GRADLE_GLOBS);
  for (const buildFile of buildFiles) {
    const content = readFileSafe(projectPath, buildFile);
    if (content === undefined) continue;
    const rootPath = path.dirname(buildFile);
    out.push({
      root_path: rootPath,
      name: moduleNameFromRoot(rootPath, projectPath, displayName),
      tier: 3,
      kind: 'package',
      evidence: [`Gradle build file: ${buildFile}`],
    });
  }

  const settingsFiles = globSafe(projectPath, SETTINGS_GRADLE_GLOBS);
  for (const settingsFile of settingsFiles) {
    const content = readFileSafe(projectPath, settingsFile);
    if (content === undefined) continue;
    const nameMatch = content.match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/);
    const rootPath = path.dirname(settingsFile);
    out.push({
      root_path: rootPath,
      name: nameMatch?.[1] || moduleNameFromRoot(rootPath, projectPath, displayName),
      tier: 3,
      kind: 'package',
      evidence: [`Gradle settings file: ${settingsFile}`, ...(nameMatch ? [`rootProject.name: ${nameMatch[1]}`] : [])],
    });
  }

  return out;
}

function collect(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const springBoot = collectSpringBootApplications(ctx);
  const gradleApps = collectGradleApplicationTargets(ctx);
  const mavenApps = collectMavenRunnableTargets(ctx);

  const claimedModuleRoots = new Set<string>([
    ...springBoot.map(e => e.root_path),
    ...gradleApps.map(e => e.root_path),
    ...mavenApps.map(e => e.root_path),
  ]);
  const bareMains = collectBareMainMethods(ctx, claimedModuleRoots);
  const packages = collectPackageIdentity(ctx);

  return [...springBoot, ...gradleApps, ...mavenApps, ...bareMains, ...packages];
}

export const jvmProvider: EvidenceProvider = {
  id: 'jvm',
  tier: 2,
  collect,
};
