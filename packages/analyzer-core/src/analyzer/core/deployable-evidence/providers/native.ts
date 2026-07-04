import * as fs from 'fs-extra';
import * as path from 'path';
import type { DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { IGNORE_GLOBS, safeDeployableName, safeGlobSync } from '../util';

/**
 * C/C++ (CMake + plain Makefile) evidence provider.
 *
 * SHIP-UNIT NOTE (native ecosystems): unlike server ecosystems (Node/Go/JVM)
 * where a Dockerfile/compose/k8s manifest is usually the ship declaration and
 * a bare executable is only a Tier-2 "runnable" candidate, for native C/C++
 * builds the BUILD TARGET itself IS the ship unit — the built binary is
 * copied out of the build tree and distributed directly (installers, system
 * packages, container COPY of a single binary, CI release artifacts) without
 * necessarily going through a repo-level Dockerfile that this provider could
 * observe. There is no separate "ship declaration" file to point at; the
 * `add_executable`/Makefile-link-target/freestanding-main() declaration
 * itself is the ship declaration. We therefore emit this as TIER 1 'bin'
 * evidence (reusing the existing 'bin' kind — cas.types.ts has no
 * native-specific kind, and 'bin' already carries the right semantics), so
 * the shared resolver's shipped-gate (apps/mcp-server/src/cross-codebase-
 * analysis.ts applyShippedGate — "RUNNABLE is not SHIPPED", demotes Tier-2/3
 * runnables with no Tier-1 sibling referencing them once >1 runnable exists
 * in the repo) does not wrongly collapse a legitimate multi-binary CMake
 * project (e.g. `server` + `tool` both add_executable, no Dockerfile
 * anywhere) down to zero deployables. `add_library` targets remain tier 3
 * 'package' evidence only — they roll up as shared code, never their own
 * deployable, matching how Cargo library crates / npm shared packages behave
 * elsewhere in this provider set. Plain-Makefile compiler-link targets and
 * freestanding `main()` (below) get the same Tier-1 treatment for the same
 * reason — see collectMakeAndPackageIdentity / collectFreestandingMain.
 */

interface CMakeTarget {
  kind: 'executable' | 'library';
  name: string;
}

function parseCMakeTargets(content: string): CMakeTarget[] {
  const out: CMakeTarget[] = [];
  // add_executable(name ...) — first arg is the target name. Skip
  // add_executable(name ALIAS other) which defines no new binary.
  for (const match of content.matchAll(/\badd_executable\s*\(\s*([A-Za-z0-9_.:-]+)\s+([^)]*)\)/gis)) {
    const name = match[1];
    const rest = match[2] || '';
    if (/^\s*ALIAS\b/i.test(rest)) continue;
    out.push({ kind: 'executable', name });
  }
  // add_library(name ... ) — skip ALIAS/INTERFACE-only aliasing forms that
  // don't produce a distinct build artifact of their own.
  for (const match of content.matchAll(/\badd_library\s*\(\s*([A-Za-z0-9_.:-]+)\s+([^)]*)\)/gis)) {
    const name = match[1];
    const rest = match[2] || '';
    if (/^\s*ALIAS\b/i.test(rest)) continue;
    out.push({ kind: 'library', name });
  }
  return out;
}

function collectCMake(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath } = ctx;
  const out: DeployableEvidence[] = [];

  let manifests: string[] = [];
  try {
    manifests = safeGlobSync('**/CMakeLists.txt', { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
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
    for (const target of parseCMakeTargets(content)) {
      if (target.kind === 'executable') {
        out.push({
          root_path: rootPath,
          name: target.name,
          tier: 1,
          kind: 'bin',
          evidence: [`CMakeLists.txt add_executable(${target.name} ...) (${manifest}) — the build TARGET is the ship unit for native/CMake`],
        });
      } else {
        out.push({
          root_path: rootPath,
          name: target.name,
          tier: 3,
          kind: 'package',
          evidence: [`CMakeLists.txt add_library(${target.name} ...) (${manifest})`],
        });
      }
    }
  }

  return out;
}

/** Plain Makefiles: heuristic executable-target detection (a top-level rule
 *  name that isn't a conventional phony/utility target and whose recipe
 *  invokes a C/C++ compiler), plus conanfile/vcpkg.json as tier-3 identity. */
function collectMakeAndPackageIdentity(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
  const out: DeployableEvidence[] = [];

  const PHONY_TARGETS = new Set([
    'all', 'clean', 'install', 'uninstall', 'test', 'check', 'dist', 'distclean',
    'help', 'fmt', 'format', 'lint', 'docs', 'doc', 'default', '.phony',
  ]);

  let makefiles: string[] = [];
  try {
    makefiles = safeGlobSync(['**/Makefile', '**/makefile', '**/GNUmakefile'], {
      cwd: projectPath,
      ignore: IGNORE_GLOBS,
      nodir: true,
      absolute: false,
    });
  } catch {
    makefiles = [];
  }

  for (const makefile of makefiles) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(projectPath, makefile), 'utf8');
    } catch {
      continue;
    }
    const rootPath = path.dirname(makefile);
    const seen = new Set<string>();
    // Match top-level target rules: `name: deps` or `name:` at line start
    // (not indented, i.e. not a recipe line), whose recipe block invokes a
    // C/C++ compiler (cc/gcc/g++/clang/clang++) — the strongest signal that
    // the target links an executable rather than just running a phony step.
    const ruleRegex = /^([A-Za-z0-9_.\/-]+)\s*:(?!=)([^\n]*)\n((?:\t[^\n]*\n?)*)/gm;
    for (const match of content.matchAll(ruleRegex)) {
      const name = match[1];
      const recipe = match[3] || '';
      if (PHONY_TARGETS.has(name.toLowerCase())) continue;
      if (name.startsWith('.') || name.startsWith('$')) continue;
      if (seen.has(name)) continue;
      const looksLikeLink = /\b(cc|gcc|g\+\+|clang|clang\+\+)\b[^\n]*\s-o\s+\S+/i.test(recipe) || /\$\(CC\)|\$\(CXX\)/i.test(recipe);
      if (!looksLikeLink) continue;
      seen.add(name);
      out.push({
        root_path: rootPath,
        name: path.basename(name),
        tier: 1,
        kind: 'bin',
        evidence: [`Makefile target "${name}" links via compiler invocation (${makefile}) — the build TARGET is the ship unit for native/Make`],
      });
    }
  }

  // Tier-3 package identity: CMakeLists.txt itself (project() name), conanfile,
  // vcpkg.json, or a bare top-level Makefile with no other identity signal.
  let cmakeLists: string[] = [];
  try {
    cmakeLists = safeGlobSync('**/CMakeLists.txt', { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    cmakeLists = [];
  }
  for (const manifest of cmakeLists) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(projectPath, manifest), 'utf8');
    } catch {
      continue;
    }
    const projectMatch = content.match(/\bproject\s*\(\s*([A-Za-z0-9_.-]+)/i);
    if (!projectMatch) continue;
    out.push({
      root_path: path.dirname(manifest),
      name: projectMatch[1],
      tier: 3,
      kind: 'package',
      evidence: [`CMakeLists.txt project(${projectMatch[1]} ...) (${manifest})`],
    });
  }

  const conanPath = path.join(projectPath, 'conanfile.txt');
  const conanPyPath = path.join(projectPath, 'conanfile.py');
  if (fs.existsSync(conanPath) || fs.existsSync(conanPyPath)) {
    out.push({
      root_path: '.',
      name: safeDeployableName(displayName || path.basename(projectPath)),
      tier: 3,
      kind: 'package',
      evidence: [`conanfile present (${fs.existsSync(conanPath) ? 'conanfile.txt' : 'conanfile.py'})`],
    });
  }

  const vcpkgPath = path.join(projectPath, 'vcpkg.json');
  if (fs.existsSync(vcpkgPath)) {
    try {
      const json = fs.readJsonSync(vcpkgPath);
      out.push({
        root_path: '.',
        name: json.name || safeDeployableName(displayName || path.basename(projectPath)),
        tier: 3,
        kind: 'package',
        evidence: [`vcpkg.json name: ${json.name || '(unnamed)'}`],
      });
    } catch {
      // unreadable manifest contributes nothing
    }
  }

  return out;
}

/** Freestanding `int main(...)` in a .c/.cpp/.cc/.cxx file with no CMake/Make
 *  target already covering it — a weak but real runnable signal for a bare
 *  C/C++ source tree with no build system file at all. */
function collectFreestandingMain(ctx: EvidenceCollectionContext, already: DeployableEvidence[]): DeployableEvidence[] {
  const { projectPath } = ctx;
  const out: DeployableEvidence[] = [];
  // A dir is "covered" if a CMake/Make BIN target's root_path is an ancestor
  // of (or equal to) it — e.g. a CMakeLists.txt at apps/server covers
  // apps/server/src/server.cpp. Prevents double-reporting the same binary as
  // both a named build target AND a "no build system detected" freestanding
  // main() when the source lives in a src/ subdirectory of its target root.
  // Only 'bin' roots count (not tier-3 package/project-identity roots, which
  // would otherwise wrongly blanket-cover every subdirectory under '.').
  const coveredRoots = already.filter(e => e.kind === 'bin').map(e => e.root_path);
  const isCovered = (dir: string): boolean => coveredRoots.some(root => dir === root || dir.startsWith(`${root}/`));

  let sourceFiles: string[] = [];
  try {
    sourceFiles = safeGlobSync('**/*.{c,cc,cpp,cxx}', { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    sourceFiles = [];
  }

  const mainRegex = /\bint\s+main\s*\(/;
  for (const file of sourceFiles) {
    const dir = path.dirname(file);
    if (isCovered(dir)) continue;
    let content = '';
    try {
      content = fs.readFileSync(path.join(projectPath, file), 'utf8');
    } catch {
      continue;
    }
    if (!mainRegex.test(content)) continue;
    out.push({
      root_path: dir,
      name: path.basename(file, path.extname(file)),
      tier: 2,
      kind: 'bin',
      evidence: [`freestanding main() in ${file} (no CMake/Makefile target detected)`],
    });
  }

  return out;
}

function collect(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const cmakeEvidence = collectCMake(ctx);
  const makeAndIdentity = collectMakeAndPackageIdentity(ctx);
  const freestanding = collectFreestandingMain(ctx, [...cmakeEvidence, ...makeAndIdentity]);
  return [...cmakeEvidence, ...makeAndIdentity, ...freestanding];
}

export const nativeProvider: EvidenceProvider = {
  id: 'native',
  tier: 1,
  collect,
};
