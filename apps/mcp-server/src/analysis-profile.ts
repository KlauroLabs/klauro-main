import * as fs from 'fs';
import * as path from 'path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { casNodeCount } from './cas-projection';

export type AnalysisKind =
  | 'backend-service'
  | 'frontend-app'
  | 'desktop-app'
  | 'mobile-app'
  | 'worker-service'
  | 'cli-tool'
  | 'library-package'
  | 'infrastructure'
  | 'test-package'
  | 'empty'
  | 'unknown';

export interface AnalysisProfile {
  kind: AnalysisKind;
  confidence: number;
  evidence: string[];
  expectations: {
    entry_points: 'required' | 'optional' | 'not-applicable';
    call_chains: 'required' | 'optional' | 'not-applicable';
    behavioral_invariants: 'required' | 'optional' | 'not-applicable';
    security: 'required' | 'optional' | 'not-applicable';
    runtime_correlation: 'required' | 'optional' | 'not-applicable';
    flow_coverage: 'required' | 'optional' | 'not-applicable';
  };
}

const APP_ENTRY_TYPES = new Set(['http', 'websocket', 'page', 'route', 'message', 'event', 'schedule', 'cli', 'lifecycle']);

export function classifyAnalysisProfile(cas: CASOutput, projectPath: string): AnalysisProfile {
  const text = profileText(cas, projectPath);
  const productNodes = (cas.nodes || []).filter(isPrimaryProductNode);
  const productNodeIds = new Set(productNodes.map(node => node.id));
  const productEntryPoints = (cas.entry_points || []).filter(entry =>
    (!entry.source_node || productNodeIds.has(entry.source_node)) &&
    (!entry.handler?.file || isPrimaryProductPath(entry.handler.file))
  );
  const entryTypes = new Set(productEntryPoints.map(entry => entry.type));
  const nodeTypes = new Set(productNodes.map(node => node.type));
  const systemFrameworks = (cas.system?.technologies?.frameworks || []).map(framework => framework.name.toLowerCase());
  const productFrameworks = productNodes.map(node => String(node.metadata?.framework || '').toLowerCase()).filter(Boolean);
  const manifests = readManifestHints(projectPath, cas);
  const evidence: string[] = [];

  const hasProductHttpFramework = hasFramework(productFrameworks, ['nestjs', 'express', 'fastapi', 'django', 'flask', 'asp.net', 'aspnet', 'spring', 'laravel', 'symfony']);
  const hasSystemHttpFramework = hasFramework(systemFrameworks, ['nestjs', 'express', 'fastapi', 'django', 'flask', 'asp.net', 'aspnet', 'spring', 'laravel', 'symfony']);
  const hasProductFrontendFramework = hasFramework(productFrameworks, ['react', 'next', 'vue', 'angular']);
  const hasSystemFrontendFramework = hasFramework(systemFrameworks, ['react', 'next', 'vue', 'angular']);
  const hasProductDesktopFramework = hasFramework(productFrameworks, ['electron', 'tauri']);
  const hasSystemDesktopFramework = hasFramework(systemFrameworks, ['electron', 'tauri']);
  const hasWpfDesktopShape = productNodes.some(node => {
    const file = String(node.source?.file || '').replace(/\\/g, '/').toLowerCase();
    const name = String(node.name || '').toLowerCase();
    const language = String(node.metadata?.language || '').toLowerCase();
    return /\.(xaml|xaml\.cs)$/.test(file) ||
      (/\b(c#|csharp|\.net)\b/.test(language) && /\b(window|viewmodel|view model|wpf)\b/.test(`${name} ${file}`));
  });
  const hasCli = entryTypes.has('cli') || /\b(command|cli|bin|commander|yargs|click|cobra)\b/i.test(text) || manifests.hasBin;
  const hasFrontend = entryTypes.has('page') || entryTypes.has('route') || hasProductFrontendFramework || manifests.hasFrontend || (hasSystemFrontendFramework && !hasCli);
  const hasHttp = entryTypes.has('http') || hasProductHttpFramework || (hasSystemHttpFramework && !hasCli && !hasFrontend);





  const hasDesktop = manifests.hasDesktop || hasWpfDesktopShape || hasProductDesktopFramework || (hasSystemDesktopFramework && !hasCli);
  const hasProductDart = productNodes.some(node => String(node.metadata?.language || '').toLowerCase().includes('dart') || (node.source?.file || '').endsWith('.dart'));
  const hasMobile = hasProductDart || nodeTypes.has('mobile_screen') || manifests.hasFlutter || /\/(android|ios|macos)\b/i.test(projectPath);
  const hasWorker = entryTypes.has('schedule') || entryTypes.has('message') || nodeTypes.has('worker') || nodeTypes.has('scheduler') || /\b(worker|scheduler|job|queue|consumer|listener)\b/i.test(text);
  const hasInfrastructure = manifests.hasInfrastructure || /(?:^|\/)(infra|infrastructure|terraform|pulumi|helm|k8s|charts)(?:\/|$)/i.test(projectPath);
  const hasTestsOnly = isTestOnly(cas, projectPath);
  const hasAppEntry = [...entryTypes].some(type => APP_ENTRY_TYPES.has(type));

  if (casNodeCount(cas) === 0) {
    evidence.push('0 CAS nodes');
    return profile('empty', 1, evidence);
  }
  if (hasInfrastructure) {
    evidence.push('infrastructure manifest/path');
    return profile('infrastructure', 0.95, evidence);
  }
  if (hasTestsOnly) {
    evidence.push('test package or test-only source layout');
    return profile('test-package', 0.9, evidence);
  }
  if (hasMobile) {
    evidence.push('Flutter/Dart/mobile project signals');
    return profile('mobile-app', 0.9, evidence);
  }
  if (hasDesktop) {
    evidence.push('Electron/Tauri/desktop project signals');
    return profile('desktop-app', 0.9, evidence);
  }
  if (hasHttp) {
    evidence.push('HTTP/API framework or entry points');
    return profile('backend-service', 0.92, evidence);
  }
  if (hasFrontend) {
    evidence.push('frontend framework, page, or route signals');
    return profile('frontend-app', 0.88, evidence);
  }
  if (hasWorker) {
    evidence.push('worker, scheduler, queue, or listener signals');
    return profile('worker-service', 0.86, evidence);
  }
  if (hasCli) {
    evidence.push('CLI/bin/command signals');
    return profile('cli-tool', 0.84, evidence);
  }
  if (cas.system?.type === 'library' || cas.system?.type === 'package' || manifests.hasPackage || !hasAppEntry) {
    evidence.push('package/library shape with no application entry requirement');
    return profile('library-package', 0.8, evidence);
  }

  evidence.push('fallback profile');
  return profile('unknown', 0.45, evidence);
}

export function expectedEntryPointCount(profile: AnalysisProfile, cas: CASOutput): number {
  if (profile.expectations.entry_points === 'not-applicable') return 0;
  if (profile.expectations.entry_points === 'optional') return 0;
  if (casNodeCount(cas) < 10) return 0;
  return 1;
}

export function expectedCallChainCount(profile: AnalysisProfile, cas: CASOutput): number {
  if (profile.expectations.call_chains === 'not-applicable') return 0;
  const entryPoints = cas.entry_points?.length || 0;
  if (entryPoints === 0) return 0;
  if ((cas.entry_points || []).every(entry => entry.type === 'file' && entry.metadata?.inferred_orientation_only)) return 0;
  if (profile.expectations.call_chains === 'optional') return Math.min(1, entryPoints);
  return Math.max(1, Math.ceil(entryPoints * 0.35));
}

export function expectedMethodCallCount(profile: AnalysisProfile, cas: CASOutput): number {
  if (profile.kind === 'empty' || profile.kind === 'infrastructure') return 0;
  if (profile.kind === 'library-package' || profile.kind === 'test-package') return casNodeCount(cas) > 25 ? 3 : 1;
  return casNodeCount(cas) > 25 ? 10 : 1;
}

export function shouldSuppressAnswerGap(profile: AnalysisProfile, answerId: string): boolean {
  if (profile.kind === 'empty') return false;
  if (answerId === 'entry-points') return profile.expectations.entry_points !== 'required';
  if (answerId === 'representative-flow') return profile.expectations.call_chains !== 'required';
  if (answerId === 'security') return profile.expectations.security !== 'required';
  if (answerId === 'runtime-readiness') return profile.expectations.runtime_correlation !== 'required';
  if (answerId === 'external-boundaries') return profile.kind === 'library-package' || profile.kind === 'test-package' || profile.kind === 'infrastructure';
  return false;
}

export function gateExpectation(profile: AnalysisProfile, gateId: string): 'required' | 'optional' | 'not-applicable' {
  if (gateId === 'entry-points') return profile.expectations.entry_points;
  if (gateId === 'call-chains') return profile.expectations.call_chains;
  if (gateId === 'behavioral-invariants') return profile.expectations.behavioral_invariants;
  if (gateId === 'security') return profile.expectations.security;
  if (gateId === 'runtime-correlation') return profile.expectations.runtime_correlation;
  if (gateId === 'flow-coverage') return profile.expectations.flow_coverage;
  return 'required';
}

function profile(kind: AnalysisKind, confidence: number, evidence: string[]): AnalysisProfile {
  const optional = {
    entry_points: 'optional',
    call_chains: 'optional',
    behavioral_invariants: 'optional',
    security: 'optional',
    runtime_correlation: 'optional',
    flow_coverage: 'optional',
  } as const;
  const required = {
    entry_points: 'required',
    call_chains: 'required',
    behavioral_invariants: 'required',
    security: 'optional',
    runtime_correlation: 'optional',
    flow_coverage: 'required',
  } as const;

  if (kind === 'backend-service') return {
    kind,
    confidence,
    evidence,
    expectations: { ...required, security: 'required', runtime_correlation: 'optional' },
  };
  if (kind === 'frontend-app' || kind === 'mobile-app' || kind === 'desktop-app') return {
    kind,
    confidence,
    evidence,
    expectations: { ...required, security: 'optional', runtime_correlation: 'optional' },
  };
  if (kind === 'worker-service' || kind === 'cli-tool') return {
    kind,
    confidence,
    evidence,
    expectations: { ...required, security: 'optional', runtime_correlation: 'optional' },
  };
  if (kind === 'library-package') return {
    kind,
    confidence,
    evidence,
    expectations: {
      ...optional,
      entry_points: 'optional',
      call_chains: 'optional',
      behavioral_invariants: 'optional',
      security: 'not-applicable',
      runtime_correlation: 'not-applicable',
      flow_coverage: 'optional',
    },
  };
  if (kind === 'test-package' || kind === 'infrastructure') return {
    kind,
    confidence,
    evidence,
    expectations: {
      entry_points: 'not-applicable',
      call_chains: 'not-applicable',
      behavioral_invariants: 'not-applicable',
      security: 'not-applicable',
      runtime_correlation: 'not-applicable',
      flow_coverage: 'not-applicable',
    },
  };
  if (kind === 'empty') return {
    kind,
    confidence,
    evidence,
    expectations: {
      entry_points: 'not-applicable',
      call_chains: 'not-applicable',
      behavioral_invariants: 'not-applicable',
      security: 'not-applicable',
      runtime_correlation: 'not-applicable',
      flow_coverage: 'not-applicable',
    },
  };
  return {
    kind,
    confidence,
    evidence,
    expectations: required,
  };
}

function profileText(cas: CASOutput, projectPath: string): string {
  return [
    projectPath,
    cas.system?.name,
    cas.system?.type,
    ...(cas.nodes || []).filter(isPrimaryProductNode).slice(0, 200).map(node => `${node.name} ${node.type} ${node.source?.file || ''}`),
    ...(cas.entry_points || []).filter(entry => !entry.handler?.file || isPrimaryProductPath(entry.handler.file)).map(entry => `${entry.name} ${entry.type}`),
  ].filter(Boolean).join(' ').toLowerCase();
}

function hasFramework(frameworks: string[], needles: string[]): boolean {
  return frameworks.some(framework => needles.some(needle => framework.includes(needle)));
}

function readManifestHints(projectPath: string, cas: CASOutput) {
  const packageJson = readJson(path.join(projectPath, 'package.json'));
  const packageText = packageJson ? JSON.stringify(packageJson).toLowerCase() : '';
  const pubspec = readText(path.join(projectPath, 'pubspec.yaml')).toLowerCase();
  const casInfrastructure = (cas.system?.technologies?.languages || []).some(language => /terraform|hcl/i.test(language.name)) ||
    cas.nodes.some(node => /\.(tf|tfvars|hcl)$/i.test(node.source?.file || '') || node.type === 'infrastructure_resource');
  const terraform = casInfrastructure || (casNodeCount(cas) === 0 && hasTerraformSurface(projectPath));
  return {
    hasFrontend: /\b(react|next|vue|angular|vite|svelte)\b/.test(packageText),
    hasDesktop: /\b(electron|electron-vite|electron-builder|tauri|@tauri-apps\/api)\b/.test(packageText) ||
      fs.existsSync(path.join(projectPath, 'electron.vite.config.ts')) ||
      fs.existsSync(path.join(projectPath, 'electron.vite.config.js')),
    hasFlutter: Boolean(pubspec && /\bflutter\s*:|sdk:\s*flutter/.test(pubspec)),
    hasPackage: Boolean(packageJson || pubspec || fs.existsSync(path.join(projectPath, 'Cargo.toml')) || fs.existsSync(path.join(projectPath, 'go.mod'))),
    hasBin: Boolean(packageJson?.bin || packageJson?.scripts?.start || packageJson?.scripts?.cli),
    hasInfrastructure: terraform || fs.existsSync(path.join(projectPath, '.terraform-version')) || fs.existsSync(path.join(projectPath, 'Chart.yaml')) || fs.existsSync(path.join(projectPath, 'Pulumi.yaml')),
  };
}

function hasTerraformSurface(projectPath: string): boolean {
  if (fs.existsSync(path.join(projectPath, 'main.tf')) || fs.existsSync(path.join(projectPath, 'variables.tf'))) return true;
  const stack: Array<{ directory: string; depth: number }> = [{ directory: projectPath, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > 3) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.terraform-version') continue;
      const fullPath = path.join(current.directory, entry.name);
      if (entry.isFile() && /\.(tf|tfvars|hcl)$/i.test(entry.name)) return true;
      if (entry.isDirectory() && !['node_modules', 'dist', 'build', 'coverage', 'vendor', 'target'].includes(entry.name)) {
        stack.push({ directory: fullPath, depth: current.depth + 1 });
      }
    }
  }
  return false;
}

function readJson(file: string): any | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readText(file: string): string {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
}

function isTestOnly(cas: CASOutput, projectPath: string): boolean {
  const basename = path.basename(projectPath).toLowerCase();
  if (/^(test|tests|testing|.*\.tests?)$/.test(basename)) return true;
  const nodes = cas.nodes || [];
  if (nodes.length === 0) return false;
  const sourceNodes = nodes.filter(node => node.source?.file && node.type !== 'import' && node.type !== 'using');
  if (sourceNodes.length === 0) return false;
  const testish = sourceNodes.filter(node => {
    const file = (node.source?.file || '').replace(/\\/g, '/').toLowerCase();
    return node.metadata?.is_test ||
      file.includes('/test/') ||
      file.includes('/tests/') ||
      /(\.test\.|\.spec\.|_test\.|test[s]?\.(java|kt|cs|php)$)/i.test(file);
  });
  return testish.length / sourceNodes.length >= 0.8;
}

function isPrimaryProductNode(node: any): boolean {
  if (node.metadata?.is_test || node.metadata?.is_generated) return false;
  return isPrimaryProductPath(node.source?.file || node.name || '');
}

function isPrimaryProductPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (!normalized) return true;
  if (/(^|\/)(\.klauro[^/]*|\.agents|\.claude|\.codex|node_modules|dist|build|coverage|vendor|vendors|generated|fixtures?|__fixtures__|__mocks__)(\/|$)/.test(normalized)) return false;
  if (/(^|\/)(__tests__|tests?|spec|e2e|cypress|playwright)(\/|$)/.test(normalized)) return false;
  if (/\.(test|spec|stories|story)\.[a-z0-9]+$/.test(normalized)) return false;
  if (/^legacy\//.test(normalized)) return false;
  return true;
}
