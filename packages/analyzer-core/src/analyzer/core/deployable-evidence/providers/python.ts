import * as fs from 'fs-extra';
import * as path from 'path';
import type { DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { IGNORE_GLOBS, safeDeployableName, safeGlobSync } from '../util';

/** Tier-2: pyproject.toml [project.scripts] / [tool.poetry.scripts], setup.py
 *  console_scripts/entry_points — CLI entry points that ship as `bin`. */
function collectConsoleScripts(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath } = ctx;
  const out: DeployableEvidence[] = [];

  let pyprojectFiles: string[] = [];
  try {
    pyprojectFiles = safeGlobSync('**/pyproject.toml', { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    pyprojectFiles = [];
  }
  for (const manifest of pyprojectFiles) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(projectPath, manifest), 'utf8');
    } catch {
      continue;
    }
    const root = path.dirname(manifest);
    // [project.scripts] / [tool.poetry.scripts] table: `name = "module:func"`
    const scriptsSectionMatch = content.match(/\[(?:project\.scripts|tool\.poetry\.scripts)\]\s*\n((?:[^\n[]*\n)*)/);
    if (scriptsSectionMatch) {
      for (const lineMatch of scriptsSectionMatch[1].matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=\s*"([^"]+)"/gm)) {
        out.push({
          root_path: root,
          name: lineMatch[1],
          tier: 2,
          kind: 'bin',
          evidence: [`pyproject.toml [project.scripts] ${lineMatch[1]} = "${lineMatch[2]}" (${manifest})`],
        });
      }
    }
  }

  let setupFiles: string[] = [];
  try {
    setupFiles = safeGlobSync('**/setup.py', { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    setupFiles = [];
  }
  for (const manifest of setupFiles) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(projectPath, manifest), 'utf8');
    } catch {
      continue;
    }
    const root = path.dirname(manifest);
    // entry_points={'console_scripts': ['name = module:func', ...]}
    const consoleScriptsMatch = content.match(/console_scripts['"]\s*:\s*\[([^\]]*)\]/s);
    if (consoleScriptsMatch) {
      for (const entryMatch of consoleScriptsMatch[1].matchAll(/['"]\s*([A-Za-z0-9_.-]+)\s*=\s*[^'"]+['"]/g)) {
        out.push({
          root_path: root,
          name: entryMatch[1],
          tier: 2,
          kind: 'bin',
          evidence: [`setup.py console_scripts entry: ${entryMatch[1]} (${manifest})`],
        });
      }
    }
  }

  return out;
}

/** Tier-2: __main__.py with `if __name__ == '__main__':` — module runnable via
 *  `python -m package`. */
function collectMainModules(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
  const out: DeployableEvidence[] = [];
  let files: string[] = [];
  try {
    files = safeGlobSync('**/__main__.py', { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    files = [];
  }
  for (const file of files) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(projectPath, file), 'utf8');
    } catch {
      continue;
    }
    if (!/if\s+__name__\s*==\s*['"]__main__['"]/.test(content)) continue;
    const packageDir = path.dirname(file);
    out.push({
      root_path: packageDir,
      name: path.basename(packageDir) === '.' ? safeDeployableName(displayName || path.basename(projectPath)) : path.basename(packageDir),
      tier: 2,
      kind: 'bin',
      evidence: [`__main__.py with if __name__ == '__main__' guard: ${file}`],
    });
  }
  return out;
}

/** Tier-2: manage.py (Django) — server-entry. */
function collectDjango(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
  const out: DeployableEvidence[] = [];
  let files: string[] = [];
  try {
    files = safeGlobSync('**/manage.py', { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    files = [];
  }
  for (const file of files) {
    const root = path.dirname(file);
    out.push({
      root_path: root,
      name: path.basename(root) === '.' ? safeDeployableName(displayName || path.basename(projectPath)) : path.basename(root),
      tier: 2,
      kind: 'server-entry',
      evidence: [`Django manage.py: ${file}`],
    });
  }
  return out;
}

/** Tier-2: wsgi.py/asgi.py (gunicorn/uvicorn target) or a Flask/FastAPI `app = `
 *  instantiation — web server entry points. */
function collectWsgiAsgiApp(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
  const out: DeployableEvidence[] = [];
  const seenRoots = new Set<string>();

  let wsgiAsgiFiles: string[] = [];
  try {
    wsgiAsgiFiles = safeGlobSync(['**/wsgi.py', '**/asgi.py'], { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    wsgiAsgiFiles = [];
  }
  for (const file of wsgiAsgiFiles) {
    const root = path.dirname(file);
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    out.push({
      root_path: root,
      name: path.basename(root) === '.' ? safeDeployableName(displayName || path.basename(projectPath)) : path.basename(root),
      tier: 2,
      kind: 'server-entry',
      evidence: [`${path.basename(file)} present (gunicorn/uvicorn target): ${file}`],
    });
  }

  // Flask/FastAPI `app = Flask(...)` / `app = FastAPI(...)` at module scope.
  let pyFiles: string[] = [];
  try {
    pyFiles = safeGlobSync('**/*.py', { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    pyFiles = [];
  }
  for (const file of pyFiles) {
    const root = path.dirname(file);
    if (seenRoots.has(root)) continue;
    let content = '';
    try {
      content = fs.readFileSync(path.join(projectPath, file), 'utf8');
    } catch {
      continue;
    }
    const match = content.match(/^\s*(?:app|application)\s*=\s*(Flask|FastAPI)\s*\(/m);
    if (!match) continue;
    seenRoots.add(root);
    out.push({
      root_path: root,
      name: path.basename(root) === '.' ? safeDeployableName(displayName || path.basename(projectPath)) : path.basename(root),
      tier: 2,
      kind: 'server-entry',
      evidence: [`${match[1]} app instantiation: ${file}`],
    });
  }

  return out;
}

/** Tier-3: pyproject.toml / setup.py / requirements.txt as package identity. */
function collectPackageIdentity(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
  const out: DeployableEvidence[] = [];

  const pyprojectPath = path.join(projectPath, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath)) {
    try {
      const content = fs.readFileSync(pyprojectPath, 'utf8');
      const name = content.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
      const version = content.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
      if (name) {
        out.push({
          root_path: '.',
          name,
          tier: 3,
          kind: 'package',
          evidence: [`pyproject.toml name: ${name}`, ...(version ? [`version: ${version}`] : [])],
        });
      }
    } catch {
      // unreadable manifest contributes nothing
    }
  }

  const setupPyPath = path.join(projectPath, 'setup.py');
  if (!fs.existsSync(pyprojectPath) && fs.existsSync(setupPyPath)) {
    try {
      const content = fs.readFileSync(setupPyPath, 'utf8');
      const name = content.match(/name\s*=\s*['"]([^'"]+)['"]/)?.[1];
      if (name) {
        out.push({
          root_path: '.',
          name,
          tier: 3,
          kind: 'package',
          evidence: [`setup.py name: ${name}`],
        });
      }
    } catch {
      // unreadable manifest contributes nothing
    }
  }

  const requirementsPath = path.join(projectPath, 'requirements.txt');
  if (!fs.existsSync(pyprojectPath) && !fs.existsSync(setupPyPath) && fs.existsSync(requirementsPath)) {
    out.push({
      root_path: '.',
      name: safeDeployableName(displayName || path.basename(projectPath)),
      tier: 3,
      kind: 'package',
      evidence: [`requirements.txt present: ${path.basename(requirementsPath)}`],
    });
  }

  return out;
}

function collect(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  return [
    ...collectDjango(ctx),
    ...collectWsgiAsgiApp(ctx),
    ...collectConsoleScripts(ctx),
    ...collectMainModules(ctx),
    ...collectPackageIdentity(ctx),
  ];
}

export const pythonProvider: EvidenceProvider = {
  id: 'python',
  tier: 2,
  collect,
};
