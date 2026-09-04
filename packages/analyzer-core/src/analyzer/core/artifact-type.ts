import * as fs from 'fs-extra';
import * as path from 'path';
import type { CASArtifactType, CASExitPoint, CASNode } from '../../types/cas.types';














export interface ArtifactManifestSignal {
  packageJson?: {
    name?: string;
    description?: string;
    isPrivate: boolean;
    hasBin: boolean;

    hasLibraryEntry: boolean;
    dependencyNames: string[];
  };
  cargo?: {
    description?: string;
    hasLibSection: boolean;
    hasBinTarget: boolean;
    hasLibFile: boolean;
    hasMainFile: boolean;
    isWorkspace?: boolean;
    dependencyNames: string[];
  };
  composer?: {
    name?: string;
    description?: string;
    type?: string;
    requireNames: string[];
  };
  pythonSetup?: {
    description?: string;
    hasConsoleScripts: boolean;
    dependencyNames: string[];
  };

  readmeLead?: string;
}

export interface ArtifactTypeInput {
  nodes: Array<Pick<CASNode, 'name' | 'type' | 'source' | 'metadata'>>;
  entryPointSummary: Array<{ type: string; count: number }>;
  exitPoints: Array<Pick<CASExitPoint, 'type' | 'name' | 'target'>>;
  frameworks: string[];
  manifest: ArtifactManifestSignal;
}

export interface ArtifactTypeResult {
  artifactType: CASArtifactType;

  evidence: string[];

  protocol?: 'soap' | 'openapi' | 'graphql';

  generated?: boolean;
}

const APP_ENTRY_TYPES = new Set(['http', 'route', 'page', 'websocket', 'event', 'schedule', 'message']);
const OUTBOUND_EXIT_TYPES = new Set(['api', 'sdk', 'message', 'webhook']);

const CLI_DEPENDENCY_MARKERS = /^(commander|yargs|oclif|@oclif\/.+|meow|cac|vorpal|inquirer|clap|structopt|click|typer|argparse|cobra)$/;
export const APP_FRAMEWORK_MARKERS = /\b(next(\.js)?|nuxt|express|fastify|koa|nestjs|nest|django|flask|fastapi|rails|laravel|symfony|spring|asp\.?net|angular|remix|sveltekit)\b/i;


const BOILERPLATE_TEXT = /\b(boilerplate|starter[ -]?(kit|template|project|app)?|skeleton|scaffold(ing)?|template)\b/i;






const DECLARED_SCAFFOLD_SUBJECT = /^\s*(?:the|a|an)\s+(?:[\w-]+\s+){0,2}?(?:boilerplate|starter|skeleton|scaffold(?:ing)?|template)\s+(?:application|app|project|repo(?:sitory)?|kit|codebase)\b/i;



const ARTIFACT_KIND_TOKENS = /^(?:framework|library|platform|core|js|ts|node)$/;

const GENERATED_CLIENT_TEXT = /\b(wsdl2?php|wsdl|openapi-generator|swagger-codegen|autorest|auto-?generated client|generated (api )?client)\b/i;

function entryCount(summary: Array<{ type: string; count: number }>, predicate: (type: string) => boolean): number {
  return summary
    .filter(entry => predicate(entry.type))
    .reduce((total, entry) => total + entry.count, 0);
}

export function classifyArtifactType(input: ArtifactTypeInput): ArtifactTypeResult {
  const { nodes, entryPointSummary, exitPoints, frameworks, manifest } = input;
  const appEntries = entryCount(entryPointSummary, type => APP_ENTRY_TYPES.has(type));
  const cliEntries = entryCount(entryPointSummary, type => type === 'cli');
  const outboundExits = exitPoints.filter(exit => OUTBOUND_EXIT_TYPES.has(exit.type)).length;

  const clientSdk = detectClientSdk(nodes, manifest, appEntries, outboundExits);
  if (clientSdk) return clientSdk;

  const boilerplate = detectBoilerplate(manifest, appEntries);
  if (boilerplate) return boilerplate;

  const infrastructure = detectInfrastructure(nodes, appEntries);
  if (infrastructure) return infrastructure;

  const cliTool = detectCliTool(manifest, appEntries, cliEntries);
  if (cliTool) return cliTool;

  const library = detectLibrary(nodes, manifest, frameworks, appEntries, cliEntries);
  if (library) return library;

  return { artifactType: 'app', evidence: ['default: no library/client/cli/boilerplate markers'] };
}

function detectInfrastructure(
  nodes: ArtifactTypeInput['nodes'],
  appEntries: number,
): ArtifactTypeResult | null {
  if (appEntries > 0) return null;
  const surfaces = new Set<string>();
  for (const node of nodes) {
    const type = String(node.type || '').toLowerCase();
    const file = String(node.source?.file || '').replace(/\\/g, '/').toLowerCase();
    if (type.includes('terraform') || /(^|\/)main\.tf$|\.tf$/.test(file)) surfaces.add('terraform');
    if (type.includes('kubernetes') || type.startsWith('k8s_') || /(^|\/)k8s\//.test(file)) surfaces.add('kubernetes');
    if (type.includes('docker') || /(^|\/)dockerfile$/.test(file)) surfaces.add('container');
    if (type.includes('compose') || /docker-compose[^/]*\.ya?ml$|compose\.ya?ml$/.test(file)) surfaces.add('compose');
    if (type.includes('pipeline') || /(^|\/)(\.github\/workflows|\.gitlab-ci|jenkinsfile|azure-pipelines)/.test(file)) surfaces.add('ci-cd');
    if (type.includes('helm') || /(^|\/)charts?\//.test(file)) surfaces.add('helm');
  }
  if (surfaces.size < 2) return null;
  return {
    artifactType: 'infrastructure',
    evidence: [`${surfaces.size} infrastructure surfaces: ${[...surfaces].sort().join(', ')}`, '0 application entry points'],
  };
}





function detectClientSdk(
  nodes: ArtifactTypeInput['nodes'],
  manifest: ArtifactManifestSignal,
  appEntries: number,
  outboundExits: number
): ArtifactTypeResult | null {
  if (appEntries > 0) return null;

  const evidence: string[] = [];
  let protocol: ArtifactTypeResult['protocol'];
  let generated = false;

  const composerSoapClient = manifest.composer?.type === 'library' &&
    manifest.composer.requireNames.some(name => name === 'ext-soap');
  if (composerSoapClient) {
    evidence.push('composer type:library requiring ext-soap');
    protocol = 'soap';
  }

  const textCorpus = [
    manifest.readmeLead || '',
    manifest.packageJson?.description || '',
    manifest.composer?.description || '',
  ].join('\n');
  const textMarker = textCorpus.match(GENERATED_CLIENT_TEXT);
  if (textMarker) {
    evidence.push(`generated-client text marker: ${textMarker[0].toLowerCase()}`);
    generated = true;
    if (/wsdl/i.test(textMarker[0])) protocol = 'soap';
    else if (/openapi|swagger|autorest/i.test(textMarker[0])) protocol = 'openapi';
  }

  const soapPathNodes = nodes.filter(node => /(^|\/)(soap|wsdl)s?(\/|\.)/i.test(node.source?.file || ''));
  const clientNamedNodes = nodes.filter(node => /(WS|SoapClient|ApiClient|Client)$/.test(node.name || ''));
  const generatedNodes = nodes.filter(node => node.metadata?.is_generated);
  if (soapPathNodes.length >= 3) {
    evidence.push(`${soapPathNodes.length} nodes under soap/wsdl paths`);
    protocol = protocol || 'soap';
    generated = true;
  }
  if (generatedNodes.length >= 5) {
    evidence.push(`${generatedNodes.length} generated nodes`);
    generated = true;
  }



  const hasGenerationMarker = composerSoapClient || generated;
  const hasClientMass = clientNamedNodes.length >= 2 || soapPathNodes.length >= 3;
  const outboundOriented = outboundExits > 0 || protocol === 'soap';
  if (!hasGenerationMarker || !hasClientMass || !outboundOriented) return null;

  evidence.push(`${clientNamedNodes.length} *Client/*WS-named nodes, ${outboundExits} outbound exits, 0 app entry points`);
  return { artifactType: 'client-sdk', evidence, protocol, generated };
}






function detectBoilerplate(manifest: ArtifactManifestSignal, appEntries: number): ArtifactTypeResult | null {
  const candidates: Array<{ text: string; where: string }> = [
    { text: (manifest.readmeLead || '').slice(0, 300), where: 'README title region' },
    { text: manifest.packageJson?.name || '', where: 'package.json name' },
    { text: manifest.packageJson?.description || '', where: 'package.json description' },
    { text: manifest.composer?.description || '', where: 'composer.json description' },
  ];
  for (const candidate of candidates) {
    const match = candidate.text.match(BOILERPLATE_TEXT);
    if (match) {
      const declaredInTitleOrName = candidate.where === 'README title region' ||
        candidate.where === 'package.json name' ||
        DECLARED_SCAFFOLD_SUBJECT.test(candidate.text);
      if (appEntries > 0 && !declaredInTitleOrName) continue;
      return {
        artifactType: 'boilerplate',
        evidence: [`${candidate.where} declares "${match[0].toLowerCase()}"`],
      };
    }
  }
  return null;
}


function detectCliTool(
  manifest: ArtifactManifestSignal,
  appEntries: number,
  cliEntries: number
): ArtifactTypeResult | null {
  if (appEntries > 0) return null;

  const evidence: string[] = [];
  if (manifest.packageJson?.hasBin) evidence.push('package.json bin field');
  if (manifest.pythonSetup?.hasConsoleScripts) evidence.push('python console_scripts entry point');
  const cliDependency = [
    ...(manifest.packageJson?.dependencyNames || []),
    ...(manifest.cargo?.dependencyNames || []),
    ...(manifest.pythonSetup?.dependencyNames || []),
  ].find(name => CLI_DEPENDENCY_MARKERS.test(name.toLowerCase()));
  if (cliDependency) evidence.push(`CLI framework dependency: ${cliDependency}`);
  if (cliEntries > 0) evidence.push(`${cliEntries} cli entry points, 0 server/page entry points`);



  const manifestMarker = manifest.packageJson?.hasBin ||
    manifest.pythonSetup?.hasConsoleScripts ||
    Boolean(cliDependency);
  if (!manifestMarker) return null;
  return { artifactType: 'cli-tool', evidence };
}






function identityTokens(name: string | undefined): string[] {
  return String(name || '')
    .replace(/^@[^/]+\//, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3 && !ARTIFACT_KIND_TOKENS.test(token));
}






function detectSelfNamedFramework(manifest: ArtifactManifestSignal, frameworks: string[]): ArtifactTypeResult | null {
  const selfNames = [
    manifest.packageJson?.name,
    manifest.composer?.name?.split('/').pop(),
  ];
  for (const selfName of selfNames) {
    const self = new Set(identityTokens(selfName));
    if (self.size === 0) continue;
    const framework = frameworks.find(candidate => identityTokens(candidate).some(token => self.has(token)));
    if (framework) {
      return {
        artifactType: 'library',
        evidence: [`manifest name "${selfName}" is the detected framework "${framework}": the repository is the framework, not an application built on it`],
      };
    }
  }
  return null;
}

function detectLibrary(
  nodes: ArtifactTypeInput['nodes'],
  manifest: ArtifactManifestSignal,
  frameworks: string[],
  appEntries: number,
  cliEntries: number
): ArtifactTypeResult | null {
  const selfNamedFramework = detectSelfNamedFramework(manifest, frameworks);
  if (selfNamedFramework) return selfNamedFramework;

  const readmeDeclaresLibrary = /\b(?:is|provides?)\s+(?:an?\s+)?[^.\n]{0,120}\blibrar(?:y|ies)\b/i.test(manifest.readmeLead || '');
  const workspaceLibrarySurface = Boolean(
    manifest.cargo?.isWorkspace &&
    readmeDeclaresLibrary &&
    nodes.some(node => /^(?!examples?\/|tests?\/)[^/]+\/src\/lib\.rs$/i.test(String(node.source?.file || '').replace(/\\/g, '/')))
  );
  if ((appEntries > 0 || cliEntries > 0) && !workspaceLibrarySurface) return null;

  if (workspaceLibrarySurface) {
    return {
      artifactType: 'library',
      evidence: ['Cargo workspace README declares a library and exposes member src/lib.rs targets'],
    };
  }

  if (manifest.cargo) {
    const cargoLib = (manifest.cargo.hasLibSection || manifest.cargo.hasLibFile) &&
      !manifest.cargo.hasBinTarget && !manifest.cargo.hasMainFile;
    if (cargoLib) {
      return {
        artifactType: 'library',
        evidence: ['Cargo lib target without [[bin]] or src/main.rs'],
      };
    }
  }

  if (manifest.composer?.type === 'library') {
    return {
      artifactType: 'library',
      evidence: ['composer.json type:library, no app entry points'],
    };
  }

  if (manifest.packageJson?.hasLibraryEntry && !manifest.packageJson.hasBin && !manifest.packageJson.isPrivate) {
    const frameworkText = frameworks.join(' ');
    const hasAppFramework = APP_FRAMEWORK_MARKERS.test(frameworkText);
    const exportedNodes = nodes.filter(node => node.metadata?.is_exported).length;
    if (!hasAppFramework && exportedNodes >= 5) {
      return {
        artifactType: 'library',
        evidence: [
          `package.json main/exports publish surface, ${exportedNodes} exported nodes, no app framework or entry points`,
        ],
      };
    }
  }

  return null;
}

const GENERIC_QUALIFIER_TOKENS = new Set([
  'app', 'application', 'system', 'service', 'platform', 'project', 'core', 'common', 'main', 'base',
  'data', 'item', 'items', 'object', 'objects', 'manager', 'management', 'managing', 'manage', 'util', 'utils', 'utility',
  'helper', 'helpers', 'handler', 'handlers', 'config', 'configuration', 'settings', 'state', 'status',
  'user', 'users', 'account', 'accounts', 'auth', 'authentication', 'session', 'sessions', 'login', 'identity',
  'test', 'tests', 'testing', 'example', 'examples', 'demo', 'modern', 'pure', 'simple', 'new', 'advanced',
  'client', 'server', 'api', 'web', 'library', 'lib', 'sdk', 'cli', 'tool', 'boilerplate', 'starter', 'template',
  'implementation', 'module', 'package', 'framework', 'component', 'components', 'page', 'pages', 'view', 'views',
  'error', 'errors', 'event', 'events', 'request', 'response', 'message', 'menu', 'list', 'detail', 'details',
  'typescript', 'javascript', 'python', 'rust', 'php', 'java', 'dart', 'node', 'nodejs',
]);








export function artifactLedDomainLabel(
  result: ArtifactTypeResult,
  qualifierCandidates: string[],
  frameworks: string[]
): string | null {
  if (result.artifactType === 'client-sdk') {
    if (result.protocol === 'soap') return 'soap-client-library';
    if (result.protocol === 'openapi') return 'rest-client-library';
    if (result.protocol === 'graphql') return 'graphql-client-library';
    const tokens = topQualifierTokens(qualifierCandidates, 2);
    if (tokens.length > 0) return `${tokens.join('-')}-client-library`;
    return 'api-client-library';
  }

  if (result.artifactType === 'boilerplate') {
    const frameworkQualifier = frameworks
      .map(framework => framework.toLowerCase().replace(/[^a-z0-9]+/g, ''))
      .find(framework => /^(react|vue|angular|svelte|next|nextjs|nuxt|flutter|django|laravel|rails|express)/.test(framework));
    if (frameworkQualifier) {
      const normalized = frameworkQualifier.replace(/^nextjs$/, 'next');
      return `${normalized}-boilerplate`;
    }
    return 'project-boilerplate';
  }

  if (result.artifactType === 'library') {
    const tokens = topQualifierTokens(qualifierCandidates, 2);
    if (tokens.length > 0) return `${tokens.join('-')}-library`;
    return 'utility-library';
  }

  return null;
}


function topQualifierTokens(candidates: string[], limit: number): string[] {
  const tokens: string[] = [];
  for (const candidate of candidates) {
    const words = String(candidate || '')

      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    for (const word of words) {
      if (word.length < 3) continue;
      if (GENERIC_QUALIFIER_TOKENS.has(word)) continue;
      if (tokens.includes(word)) continue;
      tokens.push(word);
      if (tokens.length >= limit) return tokens;
    }
  }
  return tokens;
}





export function collectArtifactManifestSignal(projectPath: string): ArtifactManifestSignal {
  if (!projectPath) return {};
  const signal: ArtifactManifestSignal = {};

  const packageJson = safeReadJson(path.join(projectPath, 'package.json'));
  if (packageJson) {
    signal.packageJson = {
      name: stringOrUndefined(packageJson.name),
      description: stringOrUndefined(packageJson.description),
      isPrivate: packageJson.private === true,
      hasBin: Boolean(packageJson.bin),
      hasLibraryEntry: Boolean(packageJson.main || packageJson.module || packageJson.exports || packageJson.types),
      dependencyNames: [
        ...Object.keys(packageJson.dependencies || {}),
        ...Object.keys(packageJson.devDependencies || {}),
      ],
    };
  }

  const cargoText = safeReadText(path.join(projectPath, 'Cargo.toml'), 20000);
  if (cargoText) {
    signal.cargo = {
      description: extractTomlString(cargoText, 'description'),
      hasLibSection: /^\s*\[lib\]/m.test(cargoText),
      hasBinTarget: /^\s*\[\[bin\]\]/m.test(cargoText),
      hasLibFile: fs.existsSync(path.join(projectPath, 'src', 'lib.rs')),
      hasMainFile: fs.existsSync(path.join(projectPath, 'src', 'main.rs')),
      isWorkspace: /^\s*\[workspace\]/m.test(cargoText),
      dependencyNames: extractCargoDependencyNames(cargoText),
    };
  }

  const composerJson = safeReadJson(path.join(projectPath, 'composer.json'));
  if (composerJson) {
    signal.composer = {
      name: stringOrUndefined(composerJson.name),
      description: stringOrUndefined(composerJson.description),
      type: stringOrUndefined(composerJson.type),
      requireNames: Object.keys(composerJson.require || {}),
    };
  }

  const setupCfg = safeReadText(path.join(projectPath, 'setup.cfg'), 20000);
  const setupPy = safeReadText(path.join(projectPath, 'setup.py'), 20000);
  const pyprojectToml = safeReadText(path.join(projectPath, 'pyproject.toml'), 20000);
  const pythonText = [setupCfg, setupPy, pyprojectToml].filter(Boolean).join('\n');
  if (pythonText) {
    signal.pythonSetup = {
      description: extractTomlString(pythonText, 'description') ||
        (pythonText.match(/^\s*description\s*=\s*(.+)$/m)?.[1] || '').trim() || undefined,
      hasConsoleScripts: /console_scripts|\[project\.scripts\]/.test(pythonText),
      dependencyNames: extractPythonDependencyNames(pythonText),
    };
  }

  for (const readmeName of ['README.md', 'README.mdx', 'readme.md', 'README.rst', 'README.txt', 'README']) {
    const readme = safeReadText(path.join(projectPath, readmeName), 1500);
    if (readme) {
      signal.readmeLead = readme;
      break;
    }
  }

  return signal;
}

function safeReadJson(filePath: string): any | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readJsonSync(filePath);
  } catch {
    return null;
  }
}

function safeReadText(filePath: string, maxLength: number): string | null {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    return fs.readFileSync(filePath, 'utf8').slice(0, maxLength);
  } catch {
    return null;
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function extractTomlString(toml: string, key: string): string | undefined {
  const match = toml.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return match?.[1] || undefined;
}

function extractCargoDependencyNames(cargoText: string): string[] {
  const names: string[] = [];
  const sections = cargoText.split(/^\s*\[/m);
  for (const section of sections) {
    if (!/^([^\]]*\.)?dependencies\]/.test(section)) continue;
    for (const line of section.split('\n').slice(1)) {
      const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
      if (match) names.push(match[1]);
    }
  }
  return names;
}

function extractPythonDependencyNames(pythonText: string): string[] {
  const names: string[] = [];
  for (const match of pythonText.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*(?:>=|==|~=|>|<)/gm)) {
    names.push(match[1]);
  }
  return names;
}
