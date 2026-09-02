import { AnalysisContext, BaseAnalyzer, FileAnalysisContext, FileAnalysisResult } from '../core/base-analyzer';
import { CASEntryPoint, CASNode } from '../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../core/glob-cache';

type DistributionArtifactKind =
  | 'desktop-entry'
  | 'service-unit'
  | 'installer'
  | 'install-script'
  | 'release-script'
  | 'shell-script'
  | 'powershell-script'
  | 'batch-script';

interface ParsedDistributionArtifact {
  kind: DistributionArtifactKind;
  role: 'desktop-ui' | 'service' | 'installer' | 'install-script' | 'release-script' | 'script';
  name: string;
  productName?: string;
  binaryNames: string[];
  serviceNames: string[];
  installPaths: string[];
  platforms: string[];
  line: number;
}

export class DistributionArtifactAnalyzer extends BaseAnalyzer {
  constructor() {
    super('distribution-artifacts', 'Distribution Artifact Analyzer', '1.0.0', 'language');
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    return (await this.getRelevantFiles(projectPath)).length > 0;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const candidates = await glob([
      '**/*.sh',
      '**/*.bash',
      '**/*.zsh',
      '**/*.ps1',
      '**/*.psm1',
      '**/*.bat',
      '**/*.cmd',
      '**/*.nsi',
      '**/*.wxs',
      '**/*.desktop',
      '**/*.service',
      '**/install',
      '**/install.*',
      '**/*installer*',
      '**/*release*',
      '**/*manifest*',
    ], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
      absolute: false,
    });
    const relevant: string[] = [];
    for (const candidate of candidates) {
      if (await this.analyzeArtifact(projectPath, candidate)) relevant.push(candidate);
    }
    return relevant;
  }

  async analyze(context: AnalysisContext) {
    const files = this.capAndPrioritizeSourceFiles(await this.getRelevantFiles(context.projectPath), 'distribution artifact files');
    const nodes: CASNode[] = [];
    const entryPoints: CASEntryPoint[] = [];
    for (const relativeFile of files) {
      const parsed = await this.analyzeArtifact(context.projectPath, relativeFile);
      if (!parsed) continue;
      nodes.push(parsed);
      entryPoints.push(this.createArtifactEntryPoint(parsed));
    }
    return this.createContribution(nodes, [], entryPoints, [], {
      topology_surface: 'distribution-artifacts',
      distribution_artifact_files: files.length,
    });
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const node = await this.analyzeArtifact(context.projectPath, context.relativePath);
    const content = await fs.readFile(context.filePath, 'utf8');
    const stat = await fs.stat(context.filePath);
    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      node ? [node] : [],
      [],
      node ? [this.createArtifactEntryPoint(node)] : [],
      [],
      [],
      []
    );
  }

  protected getCapabilities(): string[] {
    return [
      'distribution-artifact-detection',
      'installer-and-service-unit-detection',
      'desktop-app-bundle-detection',
      'scripted-deployment-surface-detection',
    ];
  }

  protected getLevelName(level: number): string {
    return level <= 3 ? 'distribution topology' : 'distribution detail';
  }

  private createArtifactEntryPoint(node: CASNode): CASEntryPoint {
    const metadata = node.metadata as (Record<string, unknown> & { distribution_role?: string; product_name?: string }) | undefined;
    const role = String(metadata?.distribution_role || 'script');
    const action = role === 'service' ? 'start' : role === 'installer' ? 'install' : role === 'desktop-ui' ? 'launch' : 'run';
    const type = role === 'service' ? 'lifecycle' : 'command';
    const subject = String(metadata?.product_name || node.name.replace(/^[^:]+:\s*/, ''));
    return this.createEntryPoint(
      `entry_${node.id}`,
      node.id,
      type,
      `${action.charAt(0).toUpperCase()}${action.slice(1)} ${subject}`,
      `${subject} is invoked through ${node.source?.file || 'its distribution artifact'}.`,
      { event: `${role}:${action}` },
      undefined,
      { topology_surface: 'distribution-artifacts', distribution_role: role, action },
      { node_id: node.id, method_name: action, file: node.source?.file }
    );
  }

  private async analyzeArtifact(projectPath: string, relativeFile: string): Promise<CASNode | undefined> {
    const absoluteFile = path.join(projectPath, relativeFile);
    let content = '';
    try {
      content = await fs.readFile(absoluteFile, 'utf8');
    } catch {
      return undefined;
    }

    const parsed = parseDistributionArtifact(relativeFile, content);
    if (!parsed) return undefined;

    const lineCount = content.split(/\r?\n/).length;
    return this.createNode(
      `distribution_artifact_${this.sanitizeId(relativeFile)}`,
      `${artifactDisplayName(parsed.kind)}: ${parsed.name}`,
      `distribution_${parsed.kind.replace(/-/g, '_')}`,
      3,
      relativeFile,
      parsed.line,
      lineCount,
      {
        topology_surface: 'distribution-artifacts',
        artifact_kind: parsed.kind,
        distribution_role: parsed.role,
        product_name: parsed.productName,
        binary_names: parsed.binaryNames,
        service_names: parsed.serviceNames,
        install_paths: parsed.installPaths,
        platforms: parsed.platforms,
        subcategories: ['distribution', parsed.kind, parsed.role],
      }
    );
  }
}
















const NON_ARTIFACT_SOURCE_EXTENSIONS = new Set([
  'rs', 'go', 'py', 'rb', 'java', 'kt', 'kts', 'scala', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hxx',
  'cs', 'swift', 'm', 'mm', 'php', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'dart', 'ex', 'exs',
  'erl', 'hrl', 'hs', 'lhs', 'ml', 'mli', 'fs', 'fsi', 'fsx', 'clj', 'cljs', 'cljc', 'lua', 'nim',
  'zig', 'jl', 'r', 'pl', 'pm', 'sql', 'proto', 'v', 'sv', 'vhd', 'vhdl', 'groovy', 'gradle',
]);

function isNonArtifactSourceFile(file: string): boolean {
  const match = file.toLowerCase().match(/\.([a-z0-9]+)$/);
  return Boolean(match && NON_ARTIFACT_SOURCE_EXTENSIONS.has(match[1]));
}

function parseDistributionArtifact(relativeFile: string, content: string): ParsedDistributionArtifact | undefined {
  const file = relativeFile.replace(/\\/g, '/');
  const lower = file.toLowerCase();
  if (lower.endsWith('.desktop')) return parseDesktopEntry(file, content);
  if (lower.endsWith('.service')) return parseServiceUnit(file, content);
  if (lower.endsWith('.nsi') || lower.endsWith('.wxs')) return parseInstaller(file, content);
  if (/\.(ps1|psm1)$/i.test(lower)) return parseScript(file, content, 'powershell-script');
  if (/\.(bat|cmd)$/i.test(lower)) return parseScript(file, content, 'batch-script');
  if (/\.(sh|bash|zsh)$/i.test(lower) || /(^|\/)install$/i.test(lower)) return parseScript(file, content, 'shell-script');
  if (isNonArtifactSourceFile(file)) return undefined;
  if (/installer|install|release|manifest/i.test(file) && looksLikeDistributionScript(content)) {
    return parseScript(file, content, 'release-script');
  }
  return undefined;
}

function parseDesktopEntry(file: string, content: string): ParsedDistributionArtifact {
  const name = firstIniValue(content, 'Name') || path.basename(file, '.desktop');
  const exec = firstIniValue(content, 'Exec') || '';
  return {
    kind: 'desktop-entry',
    role: 'desktop-ui',
    name,
    productName: name,
    binaryNames: binaryNamesFromText(exec),
    serviceNames: [],
    installPaths: pathValuesFromText(exec),
    platforms: ['linux'],
    line: lineOf(content, 'Name=') || 1,
  };
}

function parseServiceUnit(file: string, content: string): ParsedDistributionArtifact {
  const description = firstIniValue(content, 'Description') || path.basename(file, '.service');
  const exec = firstIniValue(content, 'ExecStart') || '';
  return {
    kind: 'service-unit',
    role: 'service',
    name: description,
    productName: productNameFromService(description),
    binaryNames: binaryNamesFromText(exec),
    serviceNames: [path.basename(file, '.service')],
    installPaths: pathValuesFromText(exec),
    platforms: ['linux'],
    line: lineOf(content, 'ExecStart=') || 1,
  };
}

function parseInstaller(file: string, content: string): ParsedDistributionArtifact {




  const rawName = firstRegex(content, /^\s*Name\s+"([A-Za-z$][^"]*)"/m)
    || firstRegex(content, /VIAddVersionKey\s+"ProductName"\s+"([A-Za-z$][^"]*)"/i);
  const productName = (rawName && resolveTemplateVar(rawName, content))
    || productNameFromFile(file);
  return {
    kind: 'installer',
    role: 'installer',
    name: productName || path.basename(file),
    productName,
    binaryNames: installerBinaryNamesFromText(content),
    serviceNames: serviceNamesFromText(content),
    installPaths: pathValuesFromText(content),
    platforms: installerPlatforms(file, content),
    line: lineOf(content, 'Name "') || 1,
  };
}















function installerBinaryNamesFromText(text: string): string[] {
  const names = new Set<string>();

  for (const match of text.matchAll(/^\s*File\s+(?:\/\S+\s+)*"([^"]+)"/gim)) {
    const value = cleanBinaryName(match[1].split(/[\\/]/).pop() || match[1]);
    if (value) names.add(value);
  }

  for (const match of text.matchAll(/^\s*OutFile\s+"([^"]+)"/gim)) {
    const value = cleanBinaryName(match[1]);
    if (value) names.add(value);
  }

  for (const match of text.matchAll(/<File\b[^>]*\b(?:Source|Name)="([^"]+)"/gi)) {
    const value = cleanBinaryName(match[1].split(/[\\/]/).pop() || match[1]);
    if (value) names.add(value);
  }
  return [...names].filter(name => !isDistributionNoiseToken(name));
}

function parseScript(file: string, content: string, kind: DistributionArtifactKind): ParsedDistributionArtifact | undefined {
  if (!looksLikeDistributionScript(content) && !/install|installer|release|manifest|deploy/i.test(file)) return undefined;













  const rawName = firstRegex(content, /APP_NAME[:=]\s*["']?([A-Za-z$][^"'\n]*)["']?/)
    || firstRegex(content, /ProductName["']?\s*[,=]\s*["']([A-Za-z$][^"']*)["']/i);
  const productName = (rawName && resolveTemplateVar(rawName, content))
    || productNameFromFile(file);
  const role = /installer/i.test(file) || /\b(makensis|msiexec|dmg|pkgbuild|create-dmg)\b/i.test(content)
    ? 'installer'
    : /release|manifest|deploy/i.test(file)
      ? 'release-script'
      : 'install-script';
  return {
    kind: role === 'installer' ? 'installer' : role === 'release-script' ? 'release-script' : kind === 'release-script' ? 'release-script' : kind,
    role,
    name: productName || path.basename(file),
    productName,
    binaryNames: binaryNamesFromText(content),
    serviceNames: serviceNamesFromText(content),
    installPaths: pathValuesFromText(content),
    platforms: scriptPlatforms(file, content),
    line: firstUsefulLine(content),
  };
}

function looksLikeDistributionScript(content: string): boolean {
  return /\b(systemctl|launchctl|makensis|msiexec|pkgbuild|create-dmg|\.app|\.service|\.desktop|InstallDir|ProgramFiles|SERVICE_NAME|BINARY_NAME|DOWNLOAD_PREFIX|release_url|manifest\.json|OutFile)\b/i.test(content);
}

function artifactDisplayName(kind: DistributionArtifactKind): string {
  return kind.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function firstIniValue(content: string, key: string): string | undefined {
  return firstRegex(content, new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*(.+?)\\s*$`, 'm'));
}

function firstRegex(content: string, regex: RegExp): string | undefined {
  const match = content.match(regex);
  return match?.[1]?.trim();
}

function lineOf(content: string, needle: string): number | undefined {
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex(line => line.includes(needle));
  return index >= 0 ? index + 1 : undefined;
}

function firstUsefulLine(content: string): number {
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex(line => /\b(systemctl|launchctl|makensis|msiexec|pkgbuild|create-dmg|SERVICE_NAME|BINARY_NAME|DOWNLOAD_PREFIX|manifest\.json)\b/i.test(line));
  return index >= 0 ? index + 1 : 1;
}

function binaryNamesFromText(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\b([A-Za-z][A-Za-z0-9_.-]{1,60})\.exe\b/gi)) {
    const value = cleanBinaryName(match[1]);
    if (value) names.add(value);
  }
  for (const match of text.matchAll(/(?:^|[\\/"'\s=])([A-Za-z][A-Za-z0-9_.-]{1,60})(?:\.exe)?(?:\s|["'\\]|$)/g)) {
    const value = cleanBinaryName(match[1]);
    if (value) names.add(value);
  }
  for (const match of text.matchAll(/\b(?:BINARY_NAME|ExecStart|Exec|MUI_FINISHPAGE_RUN)\b[^A-Za-z0-9_.-]+([A-Za-z0-9_.-]+)/gi)) {
    const value = cleanBinaryName(match[1]);
    if (value) names.add(value);
  }
  return [...names].filter(name => !isDistributionNoiseToken(name));
}

function serviceNamesFromText(text: string): string[] {
  return [...new Set([...text.matchAll(/\b([A-Za-z0-9_.-]+)\.service\b/g)].map(match => match[1]).filter(Boolean))];
}

function pathValuesFromText(text: string): string[] {
  const values = new Set<string>();
  for (const match of text.matchAll(/(?:Exec(?:Start)?=|InstallDir\s+|INSTALL_DIR[:=]\s*|BINARY_PATH[:=]\s*)["']?([^"'\n\r]+)/gi)) {
    const value = match[1]?.trim();
    if (value && /[\\/]/.test(value)) values.add(value);
  }
  return [...values];
}

function installerPlatforms(file: string, content: string): string[] {
  const text = `${file}\n${content}`.toLowerCase();
  const platforms = new Set<string>();
  if (/\b(nsi|windows|win32|win64|\.exe|programfiles)\b/.test(text)) platforms.add('windows');
  if (/\b(dmg|macos|darwin|\.app|osx)\b/.test(text)) platforms.add('macos');
  if (/\b(linux|systemd|\.desktop|\.service)\b/.test(text)) platforms.add('linux');
  return [...platforms];
}

function scriptPlatforms(file: string, content: string): string[] {
  const text = `${file}\n${content}`.toLowerCase();
  const platforms = new Set<string>();
  if (/\b(windows|win32|win64|powershell|\.exe|msiexec|makensis)\b|\.bat$|\.cmd$|\.ps1$/.test(text)) platforms.add('windows');
  if (/\b(macos|darwin|\.app|pkgbuild|create-dmg|dmg)\b/.test(text)) platforms.add('macos');
  if (/\b(linux|systemctl|systemd|\.desktop|\.service|\/usr\/local\/bin|\/opt\/)\b/.test(text)) platforms.add('linux');
  return [...platforms];
}

function productNameFromFile(file: string): string | undefined {
  const base = path.basename(file).replace(/\.(nsi|wxs|sh|bash|zsh|ps1|bat|cmd)$/i, '');




  const clean = base
    .split(/[-_\s]+/)
    .filter(token => token.length > 0 && !/^(installer|install|uninstall|uninstaller|setup|release|manifest|build|deploy)$/i.test(token))
    .join(' ')
    .trim();
  return clean || undefined;
}





const MAX_TEMPLATE_VALUE_LENGTH = 500;

























function resolveTemplateVar(value: string, content: string): string | undefined {
  if (!/\$[A-Za-z_{]/.test(value)) return value;
  if (value.length > MAX_TEMPLATE_VALUE_LENGTH) return undefined;
  const defs = buildVarDefinitions(content);
  let allResolved = true;
  const substituted = value.replace(/\$\{([A-Za-z0-9_]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, bare) => {
    const varName = braced || bare;
    const resolved = defs.get(varName);
    if (resolved === undefined || isUnresolvedTemplateText(resolved)) {
      allResolved = false;
      return match;
    }
    return resolved;
  });
  if (!allResolved) return undefined;
  const trimmed = substituted.trim();
  return trimmed || undefined;
}








function buildVarDefinitions(content: string): Map<string, string> {
  const defs = new Map<string, string>();
  for (const m of content.matchAll(/^\s*(?:set\s+)?([A-Za-z0-9_]+)\s*=\s*"?([^"\n\r]+?)"?\s*$/gim)) {
    defs.set(m[1], m[2].trim());
  }
  for (const m of content.matchAll(/^\s*!define\s+([A-Za-z0-9_]+)\s+"?([^"\n\r]+?)"?\s*$/gm)) {
    defs.set(m[1], m[2].trim());
  }
  return defs;
}




function isUnresolvedTemplateText(value: string): boolean {
  return /\$\{[A-Za-z0-9_]+\}|\$[A-Za-z_][A-Za-z0-9_]*/.test(value);
}

function productNameFromService(description: string): string | undefined {
  const match = description.match(/^([A-Z][A-Za-z0-9_.-]+)/);
  return match?.[1];
}

function cleanBinaryName(value: string): string {
  const cleaned = value
    .replace(/\.exe$/i, '')
    .replace(/^.*[\\/]/, '')
    .trim();



  return isUnresolvedTemplateText(cleaned) ? '' : cleaned;
}

function isDistributionNoiseToken(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.length < 2 ||
    /^(bin|usr|local|opt|etc|var|tmp|programfiles64|programfiles|software|service|services|run|running|echo|true|false|name|install|installer|release|version|latest|manifest|json|http|https|com|info|exe|dll|bat|ps1|app|desktop|systemctl|launchctl|sudo|curl|wget|powershell|command|force|erroraction|silentlycontinue|start|stop|restart|enable|disable|copy|file|files|folder|path|dir|directory|config|configuration|token|key|password|secret|auth|url|base_url|release_url|download_prefix|binary_name|service_name|app_name|if|then|else|fi|case|esac|for|do|done|function|use|as|set|rem|off|enabledelayedexpansion|from|with|and|or|the|this|that|phase|testing|requires|access|build|parse|source|production|staging|update|binaries|downloading|print_info|mkdir|pipefail|solid|unicode)$/i.test(lower);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
