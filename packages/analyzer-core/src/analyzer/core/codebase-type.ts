import * as fs from 'fs';
import * as path from 'path';
import type { CASEntryPoint, CASLibrary, CASNode } from '../../types/cas.types';

/**
 * Codebase-TYPE classifier.
 *
 * Deterministically classifies a repo/root into one or more coarse TYPEs from
 * evidence already on disk (manifest kind + fields) plus facts the orchestrator
 * has already extracted (entry points, libraries, node file extensions). This
 * matters because "what kind of thing is this" changes what an entry point
 * even means: a library's public surface is its exports, not routes; a CLI's
 * surface is its bin commands, not an HTTP route table.
 *
 * Deliberately NOT AI — this is the deterministic-facts-first layer per the
 * Klauro cardinal rule (structural facts + AI interpretation, never a
 * hardcoded-keyword-only guess with no evidence trail). Every classification
 * carries `signals`: the concrete evidence that produced it, so a caller (or a
 * human) can audit *why* a repo got labeled `library` instead of `cli`.
 *
 * A repo can legitimately be more than one type (a monorepo containing both a
 * `web-backend` API and a `library` package) — see `classifyCodebaseTypes`.
 * `classifyCodebaseType` returns just the single best-confidence type for
 * callers that want one answer (e.g. CASOutput.codebase_type).
 */

export type CodebaseType =
  | 'web-backend'
  | 'web-frontend'
  | 'fullstack'
  | 'library'
  | 'cli'
  | 'desktop'
  | 'mobile'
  | 'data-ml'
  | 'infra'
  | 'systems'
  | 'game'
  | 'monorepo'
  | 'unknown';

export interface CodebaseTypeSignal {
  /** Short machine-stable id for this piece of evidence, e.g. 'package.json#bin'. */
  id: string;
  /** Human-readable explanation of what was found. */
  detail: string;
  /** Which type(s) this signal supports. */
  supports: CodebaseType[];
  /** Relative weight of this signal (higher = stronger evidence). */
  weight: number;
}

export interface CodebaseTypeClassification {
  /** All types with non-trivial evidence, ordered by confidence (highest first). */
  types: Array<{ type: CodebaseType; confidence: number }>;
  /** Single best-confidence type (types[0].type, or 'unknown' if no evidence at all). */
  primary_type: CodebaseType;
  /** Confidence 0-1 for primary_type. */
  confidence: number;
  /** Every signal considered, including ones that didn't win — full audit trail. */
  signals: CodebaseTypeSignal[];
}

export interface ClassifyCodebaseTypeInput {
  projectPath: string;
  /** Already-extracted entry points for this root, if available (better than re-deriving). */
  entryPoints?: CASEntryPoint[];
  /** Already-extracted libraries/dependencies for this root, if available. */
  libraries?: CASLibrary[];
  /** Already-extracted nodes for this root, if available (used for file-extension signals). */
  nodes?: CASNode[];
}

function safeReadJson(filePath: string): any | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function safeReadText(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function safeReaddir(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

// Dependency-name -> type-signal table. Deliberately small and evidence-only:
// each entry says "if this exact dependency name is present, that's evidence
// (not proof) of X". Ambiguous/ubiquitous deps (react, express) get modest
// weight; framework-specific deps (next, electron, react-native) get more.
const DEP_TYPE_HINTS: Array<{ names: string[]; type: CodebaseType; weight: number; detail: string }> = [
  { names: ['next', 'nuxt'], type: 'fullstack', weight: 5, detail: 'meta-framework (SSR + API routes in one app)' },
  { names: ['@remix-run/react', 'remix'], type: 'fullstack', weight: 5, detail: 'Remix (SSR + loaders/actions in one app)' },
  { names: ['sveltekit', '@sveltejs/kit'], type: 'fullstack', weight: 5, detail: 'SvelteKit (SSR + endpoints in one app)' },
  { names: ['express', 'koa', 'fastify', 'hapi', '@nestjs/core', 'restify'], type: 'web-backend', weight: 3, detail: 'server-side HTTP framework' },
  { names: ['django', 'flask', 'fastapi', 'tornado', 'aiohttp', 'bottle', 'sanic'], type: 'web-backend', weight: 3, detail: 'Python web framework' },
  { names: ['rails', 'sinatra'], type: 'web-backend', weight: 3, detail: 'Ruby web framework' },
  { names: ['spring-boot', 'spring-webmvc', 'spring-web'], type: 'web-backend', weight: 3, detail: 'Spring web framework' },
  { names: ['gin', 'echo', 'fiber', 'chi'], type: 'web-backend', weight: 3, detail: 'Go web framework' },
  { names: ['axum', 'actix-web', 'rocket', 'warp'], type: 'web-backend', weight: 3, detail: 'Rust web framework' },
  { names: ['react', 'vue', 'svelte', '@angular/core', 'preact', 'solid-js'], type: 'web-frontend', weight: 2, detail: 'client UI framework' },
  { names: ['vite', 'webpack', 'parcel', 'rollup'], type: 'web-frontend', weight: 1, detail: 'frontend bundler' },
  { names: ['electron'], type: 'desktop', weight: 5, detail: 'Electron desktop shell' },
  { names: ['@tauri-apps/api', 'tauri'], type: 'desktop', weight: 5, detail: 'Tauri desktop shell' },
  { names: ['react-native', 'expo'], type: 'mobile', weight: 5, detail: 'React Native / Expo mobile framework' },
  { names: ['flutter'], type: 'mobile', weight: 5, detail: 'Flutter mobile framework' },
  { names: ['pandas', 'numpy', 'scikit-learn', 'torch', 'tensorflow', 'jax', 'jupyter', 'jupyterlab'], type: 'data-ml', weight: 4, detail: 'data/ML library' },
  { names: ['commander', 'yargs', 'clap', 'click', 'typer', 'cobra', 'cliffy'], type: 'cli', weight: 3, detail: 'CLI argument-parsing library' },
];

/** Directory-name conventions that hint at a type without full manifest parsing. */
const DIR_HINTS: Array<{ names: string[]; type: CodebaseType; weight: number; detail: string }> = [
  { names: ['notebooks', 'notebook'], type: 'data-ml', weight: 2, detail: 'notebooks/ directory' },
  { names: ['terraform', 'modules'], type: 'infra', weight: 2, detail: 'terraform/ directory' },
  { names: ['k8s', 'kubernetes', 'helm', 'charts'], type: 'infra', weight: 2, detail: 'k8s/helm manifests directory' },
  { names: ['android', 'ios'], type: 'mobile', weight: 3, detail: 'platform-native mobile directory' },
];

const NOTEBOOK_EXT = new Set(['ipynb']);
const INFRA_EXT = new Set(['tf', 'tfvars', 'bicep']);
const SYSTEMS_EXT = new Set(['c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'rs', 'zig', 'asm', 's', 'dts', 'dtsi']);
const GAME_ENGINE_MANIFESTS = new Set(['project.godot']);
const GAME_ENGINE_DIR_HINTS = new Set(['assets', 'scenes', 'prefabs']);

function pushSignal(signals: CodebaseTypeSignal[], id: string, detail: string, supports: CodebaseType[], weight: number) {
  signals.push({ id, detail, supports, weight });
}

function classifyFromNodePackageJson(projectPath: string, signals: CodebaseTypeSignal[]) {
  const pkg = safeReadJson(path.join(projectPath, 'package.json'));
  if (!pkg) return;

  const hasBin = !!pkg.bin && (typeof pkg.bin === 'string' || Object.keys(pkg.bin).length > 0);
  const hasMainOrExports = !!pkg.main || !!pkg.module || !!pkg.exports || !!pkg.types || !!pkg.typings;
  const isPrivate = pkg.private === true;
  const hasScripts = !!pkg.scripts;
  const hasWorkspaces = Array.isArray(pkg.workspaces) || (pkg.workspaces && Array.isArray(pkg.workspaces.packages));

  if (hasWorkspaces) {
    pushSignal(signals, 'package.json#workspaces', 'package.json declares npm/yarn workspaces', ['monorepo'], 4);
  }

  if (hasBin) {
    pushSignal(signals, 'package.json#bin', 'package.json declares a `bin` entry (installable CLI command)', ['cli'], 4);
  }

  // A published/publishable library: has main/exports, is not private, and has
  // no bin (a pure CLI package would be caught above but many CLIs also export
  // a programmatic API — bin dominates when both are present since `weight` for
  // cli#bin is higher).
  if (hasMainOrExports && !isPrivate) {
    pushSignal(signals, 'package.json#main-exports', 'package.json declares main/module/exports and is publishable (not private)', ['library'], 3);
  } else if (hasMainOrExports && isPrivate) {
    // Private packages with main/exports inside a monorepo are still evidence
    // of "library-shaped" (an internal shared package), just weaker.
    pushSignal(signals, 'package.json#main-exports-private', 'package.json declares main/module/exports but is private (internal package)', ['library'], 1.5);
  }

  if (!hasBin && !hasMainOrExports && hasScripts) {
    // No installable surface at all: likely an app (frontend or backend),
    // decided by deps/dirs elsewhere. Weak negative-shaped signal, so no push here
    // beyond what dependency/dir hints already contribute.
  }

  const depNames = new Set<string>([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
  ]);
  for (const hint of DEP_TYPE_HINTS) {
    for (const name of hint.names) {
      if (depNames.has(name)) {
        pushSignal(signals, `dep:${name}`, `dependency "${name}" — ${hint.detail}`, [hint.type], hint.weight);
      }
    }
  }
}

function classifyFromPythonManifest(projectPath: string, signals: CodebaseTypeSignal[]) {
  const pyproject = safeReadText(path.join(projectPath, 'pyproject.toml'));
  const setupPy = safeReadText(path.join(projectPath, 'setup.py'));
  const requirements = safeReadText(path.join(projectPath, 'requirements.txt'));
  const combined = [pyproject, setupPy, requirements].filter(Boolean).join('\n');
  if (!combined) return;

  if (pyproject && /\[project\.scripts\]|console_scripts/i.test(pyproject)) {
    pushSignal(signals, 'pyproject#scripts', 'pyproject.toml declares [project.scripts] (installable CLI entry point)', ['cli'], 4);
  }
  if (setupPy && /console_scripts|entry_points\s*=/.test(setupPy)) {
    pushSignal(signals, 'setup.py#entry_points', 'setup.py declares console_scripts entry_points', ['cli'], 4);
  }
  if (pyproject && /\[project\]/.test(pyproject) && !/\[project\.scripts\]/.test(pyproject)) {
    pushSignal(signals, 'pyproject#project', 'pyproject.toml declares a publishable [project] with no CLI scripts', ['library'], 2);
  }
  for (const hint of DEP_TYPE_HINTS) {
    for (const name of hint.names) {
      const re = new RegExp(`(^|[\\s"'>=<])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s"'>=<,]|$)`, 'im');
      if (re.test(combined)) {
        pushSignal(signals, `dep:${name}`, `dependency "${name}" — ${hint.detail}`, [hint.type], hint.weight);
      }
    }
  }
}

function classifyFromCargo(projectPath: string, signals: CodebaseTypeSignal[]) {
  const cargo = safeReadText(path.join(projectPath, 'Cargo.toml'));
  if (!cargo) return;
  if (/\[\[bin\]\]/.test(cargo) || fs.existsSync(path.join(projectPath, 'src', 'main.rs'))) {
    pushSignal(signals, 'Cargo.toml#bin', 'Cargo.toml declares a [[bin]] target or src/main.rs exists', ['cli', 'systems'], 3);
  }
  if (/\[lib\]/.test(cargo) || fs.existsSync(path.join(projectPath, 'src', 'lib.rs'))) {
    pushSignal(signals, 'Cargo.toml#lib', 'Cargo.toml declares a [lib] target or src/lib.rs exists', ['library'], 3);
  }
  for (const hint of DEP_TYPE_HINTS) {
    for (const name of hint.names) {
      if (new RegExp(`^${name}\\s*=`, 'm').test(cargo)) {
        pushSignal(signals, `dep:${name}`, `dependency "${name}" — ${hint.detail}`, [hint.type], hint.weight);
      }
    }
  }
}

function classifyFromGoMod(projectPath: string, signals: CodebaseTypeSignal[]) {
  const goMod = safeReadText(path.join(projectPath, 'go.mod'));
  if (!goMod) return;
  const hasMainGo = safeReaddir(projectPath).includes('main.go') ||
    safeReaddir(path.join(projectPath, 'cmd')).length > 0;
  if (hasMainGo) {
    pushSignal(signals, 'go#main', 'main.go or cmd/ directory present (buildable binary)', ['cli', 'web-backend'], 2);
  } else {
    pushSignal(signals, 'go.mod#no-main', 'go.mod present with no main.go/cmd — likely an importable package', ['library'], 2);
  }
  for (const hint of DEP_TYPE_HINTS) {
    for (const name of hint.names) {
      if (goMod.includes(name)) {
        pushSignal(signals, `dep:${name}`, `dependency "${name}" — ${hint.detail}`, [hint.type], hint.weight);
      }
    }
  }
}

function classifyFromDirectoriesAndExtensions(projectPath: string, signals: CodebaseTypeSignal[], nodes: CASNode[] | undefined) {
  const topLevel = safeReaddir(projectPath).map(n => n.toLowerCase());
  for (const hint of DIR_HINTS) {
    for (const name of hint.names) {
      if (topLevel.includes(name)) {
        pushSignal(signals, `dir:${name}`, hint.detail, [hint.type], hint.weight);
      }
    }
  }

  for (const gameManifest of GAME_ENGINE_MANIFESTS) {
    if (topLevel.includes(gameManifest)) {
      pushSignal(signals, `manifest:${gameManifest}`, `${gameManifest} present (game-engine project)`, ['game'], 4);
    }
  }
  const gameDirHits = [...GAME_ENGINE_DIR_HINTS].filter(d => topLevel.includes(d));
  if (gameDirHits.length >= 2) {
    pushSignal(signals, 'dirs:game-engine', `game-engine-shaped directories present (${gameDirHits.join(', ')})`, ['game'], 2);
  }

  // Terraform/HCL and k8s manifest presence anywhere near the root (shallow scan
  // — this classifier is intentionally cheap, not a full source walk).
  if (topLevel.some(n => n.endsWith('.tf'))) {
    pushSignal(signals, 'ext:.tf', '.tf files at project root', ['infra'], 3);
  }
  if (topLevel.includes('dockerfile') || topLevel.includes('docker-compose.yml') || topLevel.includes('docker-compose.yaml')) {
    pushSignal(signals, 'file:docker', 'Dockerfile/docker-compose present', ['infra'], 1);
  }

  if (!nodes || nodes.length === 0) return;
  const extCounts = new Map<string, number>();
  for (const n of nodes) {
    const file = n.source?.file;
    if (!file) continue;
    const ext = path.extname(file).replace(/^\./, '').toLowerCase();
    if (!ext) continue;
    extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
  }
  const total = [...extCounts.values()].reduce((a, b) => a + b, 0) || 1;

  let notebookCount = 0, infraCount = 0, systemsCount = 0;
  for (const [ext, count] of extCounts) {
    if (NOTEBOOK_EXT.has(ext)) notebookCount += count;
    if (INFRA_EXT.has(ext)) infraCount += count;
    if (SYSTEMS_EXT.has(ext)) systemsCount += count;
  }
  if (notebookCount / total > 0.05) {
    pushSignal(signals, 'ext:notebooks', `${notebookCount} notebook-associated nodes (${Math.round((notebookCount / total) * 100)}% of file-attributed nodes)`, ['data-ml'], 3);
  }
  if (infraCount / total > 0.1) {
    pushSignal(signals, 'ext:infra', `${infraCount} infra-language nodes (${Math.round((infraCount / total) * 100)}%)`, ['infra'], 2);
  }
  if (systemsCount / total > 0.3) {
    pushSignal(signals, 'ext:systems', `${systemsCount} systems-language nodes (${Math.round((systemsCount / total) * 100)}%)`, ['systems'], 2);
  }
}

function classifyFromEntryPoints(entryPoints: CASEntryPoint[] | undefined, signals: CodebaseTypeSignal[]) {
  if (!entryPoints || entryPoints.length === 0) return;
  const byType = new Map<string, number>();
  for (const ep of entryPoints) {
    byType.set(ep.type, (byType.get(ep.type) || 0) + 1);
  }
  const httpCount = (byType.get('http') || 0) + (byType.get('route') || 0) + (byType.get('websocket') || 0);
  const cliCount = byType.get('cli') || 0;
  const pageCount = byType.get('page') || 0;
  const eventCount = (byType.get('event') || 0) + (byType.get('message') || 0) + (byType.get('schedule') || 0);

  if (httpCount > 0) pushSignal(signals, 'entry_points:http', `${httpCount} HTTP/route/websocket entry points`, ['web-backend'], Math.min(4, 1 + httpCount / 5));
  if (cliCount > 0) pushSignal(signals, 'entry_points:cli', `${cliCount} CLI entry points`, ['cli'], Math.min(4, 1 + cliCount / 3));
  if (pageCount > 0) pushSignal(signals, 'entry_points:page', `${pageCount} page/route (frontend) entry points`, ['web-frontend'], Math.min(4, 1 + pageCount / 5));
  if (eventCount > 0) pushSignal(signals, 'entry_points:event', `${eventCount} event/message/schedule entry points`, ['web-backend'], 1);

  if (httpCount > 0 && pageCount > 0) {
    pushSignal(signals, 'entry_points:fullstack-mix', 'both HTTP/API entry points and page entry points present in one root', ['fullstack'], 2);
  }
}

/**
 * Classify a project root into every codebase TYPE with non-trivial evidence,
 * ranked by confidence. Confidence is a normalized score (0-1), not a
 * probability — it is `type's total weight / sum of all types' total weight`,
 * so it is comparable across types within one classification but not directly
 * comparable across repos.
 */
export function classifyCodebaseTypes(input: ClassifyCodebaseTypeInput): CodebaseTypeClassification {
  const { projectPath, entryPoints, libraries, nodes } = input;
  const signals: CodebaseTypeSignal[] = [];

  classifyFromNodePackageJson(projectPath, signals);
  classifyFromPythonManifest(projectPath, signals);
  classifyFromCargo(projectPath, signals);
  classifyFromGoMod(projectPath, signals);
  classifyFromDirectoriesAndExtensions(projectPath, signals, nodes);
  classifyFromEntryPoints(entryPoints, signals);

  // Fold in libraries passed by the caller too (covers roots where the caller
  // already has a parsed CASLibrary[] and we'd otherwise double-read the
  // manifest — dedupe by name+type so we don't double-count the same
  // dependency's evidence).
  if (libraries && libraries.length > 0) {
    const alreadyCounted = new Set(signals.filter(s => s.id.startsWith('dep:')).map(s => s.id));
    for (const lib of libraries) {
      for (const hint of DEP_TYPE_HINTS) {
        if (hint.names.includes(lib.name) && !alreadyCounted.has(`dep:${lib.name}`)) {
          pushSignal(signals, `dep:${lib.name}`, `dependency "${lib.name}" — ${hint.detail}`, [hint.type], hint.weight);
          alreadyCounted.add(`dep:${lib.name}`);
        }
      }
    }
  }

  const totals = new Map<CodebaseType, number>();
  for (const signal of signals) {
    for (const type of signal.supports) {
      totals.set(type, (totals.get(type) || 0) + signal.weight);
    }
  }

  const grandTotal = [...totals.values()].reduce((a, b) => a + b, 0);
  const ranked = [...totals.entries()]
    .map(([type, weight]) => ({ type, confidence: grandTotal > 0 ? weight / grandTotal : 0 }))
    .sort((a, b) => b.confidence - a.confidence);

  if (ranked.length === 0) {
    return { types: [], primary_type: 'unknown', confidence: 0, signals };
  }

  return {
    types: ranked,
    primary_type: ranked[0].type,
    confidence: ranked[0].confidence,
    signals,
  };
}

/** Convenience wrapper returning just the single best-confidence type. */
export function classifyCodebaseType(input: ClassifyCodebaseTypeInput): { codebase_type: CodebaseType; confidence: number; signals: CodebaseTypeSignal[] } {
  const result = classifyCodebaseTypes(input);
  return { codebase_type: result.primary_type, confidence: result.confidence, signals: result.signals };
}
