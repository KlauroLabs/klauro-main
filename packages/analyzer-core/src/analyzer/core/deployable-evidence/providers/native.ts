import * as fs from 'fs-extra';
import * as path from 'path';
import type { DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { IGNORE_GLOBS, safeDeployableName, safeGlobSync } from '../util';





























interface CMakeTarget {
  kind: 'executable' | 'library';
  name: string;
}

function parseCMakeTargets(content: string): CMakeTarget[] {
  const out: CMakeTarget[] = [];


  for (const match of content.matchAll(/\badd_executable\s*\(\s*([A-Za-z0-9_.:-]+)\s+([^)]*)\)/gis)) {
    const name = match[1];
    const rest = match[2] || '';
    if (/^\s*ALIAS\b/i.test(rest)) continue;
    out.push({ kind: 'executable', name });
  }


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

    }
  }

  return out;
}




function collectFreestandingMain(ctx: EvidenceCollectionContext, already: DeployableEvidence[]): DeployableEvidence[] {
  const { projectPath } = ctx;
  const out: DeployableEvidence[] = [];







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
