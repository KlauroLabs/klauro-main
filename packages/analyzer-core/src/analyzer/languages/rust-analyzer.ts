import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  CASDocumentation, CASComment, CASTodo, CASImplementationStatus,
  CASPattern, CASPerspective, CASMethodCall, CASCallChain, FileAnalysisResult
} from '../../types/cas.types';
import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import { AnalyzerError } from '../core/errors';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';
import { TreeSitterParser } from '../core/tree-sitter-parser';
import type { RustASTNode } from '../core/ast-types';
import * as path from 'path';
import { EnhancedRustCallGraphExtractor } from '../enhanced-rust-call-graph-extractor';

let detectedRustVersion: string | undefined;

const RUST_STD_MODULES = new Set([
  'std', 'core', 'alloc',
  'Vec', 'String', 'HashMap', 'HashSet', 'BTreeMap', 'BTreeSet',
  'Option', 'Result', 'Box', 'Rc', 'Arc', 'Cell', 'RefCell',
  'Mutex', 'RwLock', 'Condvar', 'Barrier',
  'Duration', 'Instant', 'SystemTime',
  'Path', 'PathBuf', 'OsStr', 'OsString',
  'File', 'Read', 'Write', 'BufRead', 'BufReader', 'BufWriter',
  'TcpStream', 'TcpListener', 'UdpSocket',
  'Command', 'Child', 'Stdio',
  'thread', 'sync', 'collections', 'io', 'fs', 'net', 'env', 'process',
  'fmt', 'str', 'slice', 'iter', 'ops', 'cmp', 'convert', 'default',
  'mem', 'ptr', 'num', 'time', 'path', 'ffi',
  'Cow', 'Deref', 'DerefMut', 'Drop', 'Clone', 'Copy',
  'Debug', 'Display', 'Default', 'PartialEq', 'Eq', 'PartialOrd', 'Ord', 'Hash',
  'Iterator', 'IntoIterator', 'FromIterator', 'Extend',
  'From', 'Into', 'TryFrom', 'TryInto', 'AsRef', 'AsMut',
  'Send', 'Sync', 'Sized', 'Unpin',
  'VecDeque', 'LinkedList', 'BinaryHeap',
  'Range', 'RangeInclusive', 'RangeFull', 'RangeFrom', 'RangeTo',
  'PhantomData', 'ManuallyDrop', 'MaybeUninit',
  'NonNull', 'NonZeroU8', 'NonZeroU16', 'NonZeroU32', 'NonZeroU64', 'NonZeroUsize',
  'Ordering', 'Reverse',
  'format', 'println', 'print', 'eprintln', 'eprint', 'dbg', 'todo', 'unimplemented', 'unreachable',
  'assert', 'assert_eq', 'assert_ne', 'debug_assert', 'debug_assert_eq', 'debug_assert_ne',
  'vec', 'format_args', 'write', 'writeln',
  'DefaultHasher', 'RandomState',
  'Error', 'ErrorKind',
  'Formatter', 'Arguments',
  'Pin', 'Waker', 'Context', 'Poll', 'Future',
  'CStr', 'CString',
]);

const RUST_PRIMITIVES = new Set([
  'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
  'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
  'f32', 'f64', 'bool', 'char', 'str',
]);

interface ExitPointCategory {
  type: 'api' | 'sdk' | 'database' | 'file' | 'cache' | 'message' | 'webhook';
  library?: string;
}

const EXIT_POINT_CATEGORIES: Record<string, ExitPointCategory> = {
  'reqwest': { type: 'sdk', library: 'reqwest' },
  'Client': { type: 'sdk', library: 'reqwest' },
  'hyper': { type: 'sdk', library: 'hyper' },
  'surf': { type: 'sdk', library: 'surf' },
  'ureq': { type: 'sdk', library: 'ureq' },
  'diesel': { type: 'database', library: 'diesel' },
  'sqlx': { type: 'database', library: 'sqlx' },
  'rusqlite': { type: 'database', library: 'rusqlite' },
  'mongodb': { type: 'database', library: 'mongodb' },
  'redis': { type: 'cache', library: 'redis' },
  'memcache': { type: 'cache', library: 'memcache' },
  'lapin': { type: 'message', library: 'lapin' },
  'rdkafka': { type: 'message', library: 'rdkafka' },
  'nats': { type: 'message', library: 'nats' },
  'TcpStream': { type: 'api' },
  'TcpListener': { type: 'api' },
  'UdpSocket': { type: 'api' },
  'ssh2': { type: 'sdk', library: 'ssh2' },
  'Session': { type: 'sdk', library: 'ssh2' },
  'Channel': { type: 'sdk', library: 'ssh2' },
  'tokio': { type: 'sdk', library: 'tokio' },
  'async_std': { type: 'sdk', library: 'async-std' },
  'File': { type: 'file' },
  'OpenOptions': { type: 'file' },
  'DirEntry': { type: 'file' },
  'ReadDir': { type: 'file' },
  'ProgressBar': { type: 'sdk', library: 'indicatif' },
  'ProgressStyle': { type: 'sdk', library: 'indicatif' },
  'Regex': { type: 'sdk', library: 'regex' },
  'serde_json': { type: 'sdk', library: 'serde_json' },
  'Value': { type: 'sdk', library: 'serde_json' },
  'Serialize': { type: 'sdk', library: 'serde' },
  'Deserialize': { type: 'sdk', library: 'serde' },
  'Parser': { type: 'sdk', library: 'clap' },
  'Command': { type: 'sdk', library: 'clap' },
  'Arg': { type: 'sdk', library: 'clap' },
  'x509_parser': { type: 'sdk', library: 'x509-parser' },
  'X509Certificate': { type: 'sdk', library: 'x509-parser' },
  'genpdf': { type: 'sdk', library: 'genpdf' },
  'Document': { type: 'sdk', library: 'genpdf' },
};

interface RustStruct {
  name: string;
  moduleName: string;
  filePath: string;
  fields: RustField[];
  generics: string[];
  attributes: string[];
  visibility: string;
  lineStart: number;
  lineEnd: number;
  isPublic: boolean;
  isUnion: boolean;
}

interface RustEnum {
  name: string;
  moduleName: string;
  filePath: string;
  variants: RustEnumVariant[];
  generics: string[];
  attributes: string[];
  visibility: string;
  lineStart: number;
  lineEnd: number;
  isPublic: boolean;
}

interface RustTrait {
  name: string;
  moduleName: string;
  filePath: string;
  methods: RustMethod[];
  associatedTypes: RustAssociatedType[];
  supertraits: string[];
  generics: string[];
  attributes: string[];
  visibility: string;
  lineStart: number;
  lineEnd: number;
  isPublic: boolean;
}

interface RustImpl {
  targetType: string;
  traitName?: string;
  methods: RustMethod[];
  filePath: string;
  lineStart: number;
  lineEnd: number;
}

interface RustFunctionCall {
  callerFunction: string;
  callerFile: string;
  callerLine: number;
  targetFunction: string;
  targetModule?: string;
  isExternal: boolean;
  isAsync: boolean;
  isMethodCall: boolean;
  callLine: number;
}

interface RustFunction {
  name: string;
  moduleName: string;
  filePath: string;
  implType?: string;
  parameters: RustParameter[];
  returnType: string;
  isAsync: boolean;
  isMain: boolean;
  isPublic: boolean;
  generics: string[];
  attributes: string[];
  body?: string;
  calls: RustFunctionCall[];
  lineStart: number;
  lineEnd: number;
}

interface RustConstant {
  name: string;
  moduleName: string;
  filePath: string;
  type: string;
  value: string;
  isPublic: boolean;
  lineStart: number;
  lineEnd: number;
}

interface RustStatic {
  name: string;
  moduleName: string;
  filePath: string;
  type: string;
  isMutable: boolean;
  isPublic: boolean;
  lineStart: number;
  lineEnd: number;
}

interface RustTypeAlias {
  name: string;
  moduleName: string;
  filePath: string;
  targetType: string;
  generics: string[];
  isPublic: boolean;
  lineStart: number;
  lineEnd: number;
}

interface RustModule {
  name: string;
  filePath: string;
  isPublic: boolean;
  lineStart: number;
  lineEnd: number;
}

interface RustUse {
  moduleName: string;
  importedItems: string[];
  isPublic: boolean;
  lineStart: number;
  lineEnd: number;
}

interface RustField {
  name: string;
  type: string;
  visibility: string;
  isPublic: boolean;
  lineNumber: number;
}

interface RustEnumVariant {
  name: string;
  fields?: RustField[];
  lineNumber: number;
}

interface RustMethod {
  name: string;
  parameters: RustParameter[];
  returnType: string;
  isAsync: boolean;
  isPublic: boolean;
  isStatic: boolean;
  generics: string[];
  attributes: string[];
  source?: RustFunction;
  lineStart: number;
  lineEnd: number;
}

interface RustAssociatedType {
  name: string;
  bounds?: string[];
  defaultType?: string;
  lineNumber: number;
}

interface RustParameter {
  name: string;
  type: string;
  isMutable: boolean;
  isSelf: boolean;
  lineNumber: number;
}

interface RustFileExtraction {
  fullPath: string;
  relativePath: string;
  structs: RustStruct[];
  enums: RustEnum[];
  traits: RustTrait[];
  impls: RustImpl[];
  functions: RustFunction[];
  constants: RustConstant[];
  statics: RustStatic[];
  types: RustTypeAlias[];
}

export class RustAnalyzer extends BaseAnalyzer {
  private actixFrameworkDetected = false;
  private rocketFrameworkDetected = false;
  private warpFrameworkDetected = false;
  private axumFrameworkDetected = false;
  private clapDetected = false;
  private structoptDetected = false;
  private tokioDetected = false;
  private asyncStdDetected = false;
  private serdeDetected = false;
  private dieselDetected = false;
  private sqlxDetected = false;
  private reqwestDetected = false;
  private hyperDetected = false;
  private tracingDetected = false;
  private mockallDetected = false;
  private cargoProject = false;
  private projectName = '';
  private projectVersion = '';
  private crateNamesByDir = new Map<string, string>();
  private crateManifestProjectPath = '';
  private astRunner: TreeSitterParser;
  private astCache = new Map<string, RustASTNode>();
  private callGraphExtractor?: EnhancedRustCallGraphExtractor;

  constructor() {
    super(
      'rust',
      'Enhanced Rust Analyzer',
      '1.5.0',
      'language'
    );
    this.astRunner = new TreeSitterParser();
    this.callGraphExtractor = undefined; // Will be initialized in analyze method
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const rustFiles = await glob(['**/*.rs'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true
      });

      const cargoFiles = await glob(['Cargo.toml', 'Cargo.lock'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true
      });

      return rustFiles.length > 0 || cargoFiles.length > 0;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await glob(['**/*.rs'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true
    });
    return files.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const methodCalls: CASMethodCall[] = [];
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    await this.detectProjectType(context.projectPath);
    this.createFileNode(context.relativePath, nodes, context);
    const extraction = await this.extractFileElements(context.filePath, nodes, edges, entryPoints, context);
    if (extraction) {
      this.linkFileElements(extraction, nodes, edges, new Set(edges.map(edge => edge.id)), exitPoints, methodCalls);
    }

    const imports = [...content.matchAll(/^\s*(?:pub\s+)?use\s+([^;]+);/gm)].map(match => match[1].trim());
    const exports = nodes
      .filter(node => ['module', 'struct', 'enum', 'trait', 'impl', 'function', 'method', 'constant', 'static', 'type'].includes(this.declarationKind(node)))
      .map(node => node.name);

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      imports,
      exports
    );
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const methodCalls: CASMethodCall[] = [];

    try {
      await this.detectProjectType(context.projectPath);
      const libraries: any[] = [];
      await this.extractDependencies(context.projectPath, libraries);

      const rustFiles = this.capAndPrioritizeSourceFiles((await glob(['**/*.rs'], {
        cwd: context.projectPath,
        ignore: this.getIgnorePatterns(context),
        nodir: true
      })).sort(), 'Rust files');

      const extractions: RustFileExtraction[] = [];
      for (const file of rustFiles) {
        const fullPath = path.resolve(context.projectPath, file);
        this.createFileNode(file, nodes, context);
        const extraction = await this.extractFileElements(fullPath, nodes, edges, entryPoints, context);
        if (extraction) extractions.push(extraction);
      }

      if (this.shouldBuildExpensiveLanguageCallGraph(rustFiles.length)) {
        const edgeIds = new Set(edges.map(edge => edge.id));
        for (const extraction of extractions) {
          this.linkFileElements(extraction, nodes, edges, edgeIds, exitPoints, methodCalls);
        }
      } else {
        this.addAnalysisWarning(
          `Rust cross-file linking deferred for ${process.env.KLAURO_ANALYSIS_FOCUS || 'default'} focus after ${rustFiles.length} prioritized files; run deep-context/full analysis for exhaustive Rust call edges`
        );
      }

      this.createExitPointsForLibraries(libraries, exitPoints, nodes);

      const applicationType = this.determineApplicationType();
      const detectedFrameworks = this.getDetectedFrameworks();
      const patterns = this.detectPatterns(nodes);
      const perspectives = this.generatePerspectives(nodes);
      const callChains = this.buildCallChains(methodCalls);

      const contribution = this.createContribution(nodes, edges, entryPoints, exitPoints, {
        analyzer_name: 'Rust Analyzer',
        rust_version: await this.getRustVersion(context.projectPath),
        project_name: this.projectName,
        project_version: this.projectVersion,
        application_type: applicationType,
        frameworks_detected: detectedFrameworks,
        crates: {
          cli: { clap: this.clapDetected, structopt: this.structoptDetected },
          async_runtime: { tokio: this.tokioDetected, async_std: this.asyncStdDetected },
          web: {
            actix: this.actixFrameworkDetected,
            rocket: this.rocketFrameworkDetected,
            warp: this.warpFrameworkDetected,
            axum: this.axumFrameworkDetected
          },
          database: { diesel: this.dieselDetected, sqlx: this.sqlxDetected },
          http_client: { reqwest: this.reqwestDetected, hyper: this.hyperDetected },
          serialization: { serde: this.serdeDetected },
          logging: { tracing: this.tracingDetected }
        }
      });

      contribution.patterns = patterns;
      contribution.perspectives = perspectives;
      contribution.provided_perspectives = perspectives.map(p => p.id);
      contribution.external_services = [];
      contribution.method_calls = methodCalls;
      contribution.call_chains = callChains;
      contribution.analyzer_metadata.framework_specific = detectedFrameworks;
      contribution.analyzer_metadata.framework_specific.actixFramework = detectedFrameworks.actix;
      (contribution as any).analyzer_contributions = [contribution.analyzer_metadata];
      (contribution as any).cas_version = '1.8.0';
      (contribution as any).analysis_timestamp = new Date().toISOString();
      (contribution as any).analysis_id = `rust:${Date.now()}`;

      return contribution;

    } catch (error) {
      console.error('Rust analysis failed:', error);
      throw new AnalyzerError(`Rust analysis failed: ${error}`, 'ANALYSIS_FAILED');
    }
  }

  private createFileNode(
    relativePath: string,
    nodes: CASNode[],
    context: AnalysisContext
  ): void {
    const fileName = path.basename(relativePath);
    const fileId = this.generateId('file', relativePath, fileName);

    const fileNode = this.createNodeBuilder(fileId, fileName, 'file')
      .withLevel(2, 'architectural')
      .withCategory('source', ['rust', 'file'])
      .withSource({ file: relativePath, line: 1 })
      .withDescription(`Rust source file: ${relativePath}`)
      .withMetadata({
        language: 'rust',
        attributes: {
          relative_path: relativePath,
          is_main: fileName === 'main.rs',
          is_lib: fileName === 'lib.rs',
          is_mod: fileName === 'mod.rs'
        }
      })
      .withAnalyzers([this.analyzerId], this.analyzerId)
      .build();

    nodes.push(fileNode);
  }

  private determineApplicationType(): string {
    if (this.actixFrameworkDetected || this.rocketFrameworkDetected ||
        this.warpFrameworkDetected || this.axumFrameworkDetected) {
      return 'Web Server';
    }
    if (this.clapDetected || this.structoptDetected) {
      return 'CLI Application';
    }
    if (this.tokioDetected || this.asyncStdDetected) {
      return 'Async Application';
    }
    return 'Library/Application';
  }

  private getDetectedFrameworks(): Record<string, boolean> {
    return {
      actix: this.actixFrameworkDetected,
      rocket: this.rocketFrameworkDetected,
      warp: this.warpFrameworkDetected,
      axum: this.axumFrameworkDetected,
      clap: this.clapDetected,
      structopt: this.structoptDetected,
      tokio: this.tokioDetected,
      async_std: this.asyncStdDetected,
      serde: this.serdeDetected,
      diesel: this.dieselDetected,
      sqlx: this.sqlxDetected,
      reqwest: this.reqwestDetected,
      hyper: this.hyperDetected,
      tracing: this.tracingDetected
    };
  }

  protected getCapabilities(): string[] {
    return [
      'rust-syntax-parsing',
      'struct-analysis',
      'trait-analysis',
      'cargo-dependency-analysis',
      'call-graph-generation',
      'function-mapping',
      'module-organization',
      'lifetime-tracking',
      'framework-detection',
      'perspective-system'
    ];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'system';
      case 2: return 'architectural';
      case 3: return 'code';
      case 4: return 'member';
      case 5: return 'implementation';
      default: return `level_${level}`;
    }
  }

  private shouldBuildExpensiveLanguageCallGraph(fileCount: number): boolean {
    const focus = process.env.KLAURO_ANALYSIS_FOCUS;
    if (focus === 'agent-fast' || focus === 'ui-overview') return fileCount <= 350;
    if (focus === 'deep-context') return fileCount <= 2000;
    return true;
  }

  private async detectProjectType(projectPath: string): Promise<void> {
    try {
      const cargoTomlPath = path.join(projectPath, 'Cargo.toml');
      const cargoLockPath = path.join(projectPath, 'Cargo.lock');

      if (await fs.pathExists(cargoTomlPath)) {
        this.cargoProject = true;
        await this.parseCargoToml(cargoTomlPath);
      }

      if (await fs.pathExists(cargoLockPath)) {
        await this.parseCargoLock(cargoLockPath);
      }

      await this.indexCrateManifests(projectPath);
    } catch (error) {
      console.warn('Failed to detect project type:', error);
    }
  }

  private async indexCrateManifests(projectPath: string): Promise<void> {
    if (this.crateManifestProjectPath === projectPath) return;
    this.crateManifestProjectPath = projectPath;
    this.crateNamesByDir = new Map<string, string>();
    const manifestFiles = (await glob(['**/Cargo.toml'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true
    })).sort();
    for (const manifestFile of manifestFiles) {
      try {
        const content = await fs.readFile(path.resolve(projectPath, manifestFile), 'utf-8');
        const packageName = this.readCargoPackageName(content);
        if (!packageName) continue;
        const dir = path.posix.dirname(manifestFile.split(path.sep).join('/'));
        this.crateNamesByDir.set(dir === '.' ? '' : dir, packageName);
      } catch {
        continue;
      }
    }
  }

  private readCargoPackageName(content: string): string | undefined {
    let currentSection = '';
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        currentSection = trimmed.slice(1, -1).toLowerCase();
        continue;
      }
      if (currentSection !== 'package' || !trimmed.includes('=')) continue;
      const [key, ...valueParts] = trimmed.split('=');
      if (key.trim() !== 'name') continue;
      const value = valueParts.join('=').trim().replace(/^["']|["']$/g, '');
      if (value) return value;
    }
    return undefined;
  }

  private crateContextForPath(posixPath: string): { dir: string; name: string } | undefined {
    let context: { dir: string; name: string } | undefined;
    for (const [dir, name] of this.crateNamesByDir) {
      if (dir !== '' && posixPath !== dir && !posixPath.startsWith(`${dir}/`)) continue;
      if (context === undefined || dir.length > context.dir.length) {
        context = { dir, name };
      }
    }
    return context;
  }

  private cliEntryMetadata(relativePath: string): Record<string, any> {
    const posixPath = relativePath.split(path.sep).join('/');
    const crateContext = this.crateContextForPath(posixPath);
    const crateDir = crateContext?.dir ?? '';
    let crate = crateContext?.name;
    if (!crate && this.projectName) crate = this.projectName;

    const pathInCrate = crateDir ? posixPath.slice(crateDir.length + 1) : posixPath;
    const segments = pathInCrate.split('/');
    const fileStem = segments[segments.length - 1].replace(/\.rs$/, '');
    const parentDir = segments.length > 1 ? segments[segments.length - 2] : '';

    const metadata: Record<string, any> = {};
    if (crate) metadata.crate = crate;
    if (fileStem === 'build' && segments.length === 1) {
      metadata.build_script = true;
      return metadata;
    }
    if (parentDir === 'bin') {
      metadata.binary = fileStem;
    } else if (parentDir === 'examples') {
      metadata.binary = fileStem;
      metadata.example = true;
    } else if (crate) {
      metadata.binary = crate;
    }
    return metadata;
  }

  private async parseCargoToml(cargoTomlPath: string): Promise<void> {
    try {
      const content = await fs.readFile(cargoTomlPath, 'utf-8');
      const lines = content.split('\n');

      let currentSection = '';

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          currentSection = trimmed.slice(1, -1).toLowerCase();
          continue;
        }

        if (currentSection === 'package' && trimmed.includes('=')) {
          const [key, ...valueParts] = trimmed.split('=');
          const value = valueParts.join('=').trim().replace(/^["']|["']$/g, '');
          const keyName = key.trim();
          if (keyName === 'name') this.projectName = value;
          else if (keyName === 'version') this.projectVersion = value;
        }

        const isDependencySection = currentSection === 'dependencies' ||
          currentSection === 'dev-dependencies' ||
          currentSection.startsWith('dependencies.') ||
          currentSection.startsWith('target.');

        if (isDependencySection && trimmed.includes('=')) {
          const [name] = trimmed.split('=');
          if (name) {
            const depName = name.trim();
            this.detectCrateDependency(depName);
          }
        }
      }
    } catch (error) {
      console.warn('Failed to parse Cargo.toml:', error);
    }
  }

  private detectCrateDependency(depName: string): void {
    switch (depName) {
      case 'actix-web':
      case 'actix-rt':
        this.actixFrameworkDetected = true;
        break;
      case 'rocket':
        this.rocketFrameworkDetected = true;
        break;
      case 'warp':
        this.warpFrameworkDetected = true;
        break;
      case 'axum':
        this.axumFrameworkDetected = true;
        break;
      case 'clap':
        this.clapDetected = true;
        break;
      case 'structopt':
        this.structoptDetected = true;
        break;
      case 'tokio':
        this.tokioDetected = true;
        break;
      case 'async-std':
        this.asyncStdDetected = true;
        break;
      case 'serde':
      case 'serde_json':
      case 'serde_yaml':
        this.serdeDetected = true;
        break;
      case 'diesel':
        this.dieselDetected = true;
        break;
      case 'sqlx':
        this.sqlxDetected = true;
        break;
      case 'reqwest':
        this.reqwestDetected = true;
        break;
      case 'hyper':
        this.hyperDetected = true;
        break;
      case 'tracing':
      case 'tracing-subscriber':
        this.tracingDetected = true;
        break;
      case 'mockall':
      case 'mocktopus':
      case 'double':
        this.mockallDetected = true;
        break;
    }
  }

  private async parseCargoLock(cargoLockPath: string): Promise<void> {
    // Basic Cargo.lock parsing - could be extended
    try {
      const content = await fs.readFile(cargoLockPath, 'utf-8');
      // For now, just check if it exists and is valid
    } catch (error) {
      console.warn('Failed to parse Cargo.lock:', error);
    }
  }

  private async extractDependencies(projectPath: string, libraries: any[]): Promise<void> {
    if (!this.cargoProject) return;

    try {
      const cargoLockPath = path.join(projectPath, 'Cargo.lock');
      if (!await fs.pathExists(cargoLockPath)) return;

      const content = await fs.readFile(cargoLockPath, 'utf-8');
      const lines = content.split('\n');

      let currentPackage: any = {};
      let inPackage = false;

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === '[[package]]') {
          if (currentPackage.name) {
            libraries.push(currentPackage);
          }
          currentPackage = {};
          inPackage = true;
        } else if (inPackage && trimmed.includes('=')) {
          const [key, ...valueParts] = trimmed.split('=');
          const value = valueParts.join('=').trim();
          if (value.startsWith('"') && value.endsWith('"')) {
            currentPackage[key.trim()] = value.slice(1, -1);
          } else {
            currentPackage[key.trim()] = value;
          }
        } else if (trimmed === '' && inPackage) {
          // End of package section
        }
      }

      if (currentPackage.name) {
        libraries.push(currentPackage);
      }
    } catch (error) {
      console.warn('Failed to extract dependencies:', error);
    }
  }

  private async extractFileElements(
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    context: AnalysisContext
  ): Promise<RustFileExtraction | undefined> {
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      const relativePath = path.relative(context.projectPath, fullPath);

      await this.extractModules(content, relativePath, nodes);
      await this.extractUses(content, relativePath, nodes);
      const structs = await this.extractStructs(content, relativePath, nodes, edges);
      const enums = await this.extractEnums(content, relativePath, nodes);
      const traits = await this.extractTraits(content, relativePath, nodes);
      const impls = await this.extractImpls(content, relativePath, nodes, edges);
      const functions = await this.extractFunctions(content, relativePath, nodes, entryPoints);
      this.extractCliSubcommands(content, relativePath, nodes, entryPoints);
      // Axum routes are emitted by the dedicated AxumAnalyzer (frameworks/rust),
      // which also resolves tower-layer auth and nest() prefixes. Keeping it here
      // too would double-emit (the framework analyzer composes this Rust analyzer).
      const constants = await this.extractConstants(content, relativePath, nodes);
      const statics = await this.extractStatics(content, relativePath, nodes);
      const types = await this.extractTypes(content, relativePath, nodes);

      return { fullPath, relativePath, structs, enums, traits, impls, functions, constants, statics, types };
    } catch (error) {
      console.warn(`Failed to analyze file ${fullPath}:`, error);
      return undefined;
    }
  }

  private linkFileElements(
    extraction: RustFileExtraction,
    nodes: CASNode[],
    edges: CASEdge[],
    edgeIds: Set<string>,
    exitPoints: CASExitPoint[],
    methodCalls: CASMethodCall[]
  ): void {
    const { relativePath, structs, enums, traits, impls, functions, constants, statics, types } = extraction;
    this.createRelationships(nodes, edges, edgeIds, structs, enums, traits, impls, functions, constants, statics, types);
    this.createMethodCalls(functions, nodes, methodCalls);
    // Pass the project-relative path (not fullPath) so exit-point ids are stable
    // across machines/snapshots. seenExitPointIds dedupes across all files in the
    // run (cargo workspaces re-emit the same relative path from multiple crates).
    this.createExitPointsFromFunctions(functions, relativePath, exitPoints, nodes);
  }

  private async extractModules(content: string, relativePath: string, nodes: CASNode[]): Promise<RustModule[]> {
    const modules: RustModule[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const modMatch = line.match(/^(?:pub\s+)?mod\s+(\w+)/);
      if (modMatch) {
        const moduleName = modMatch[1];
        const isPublic = line.includes('pub');

        const module: RustModule = {
          name: moduleName,
          filePath: relativePath,
          isPublic,
          lineStart: i + 1,
          lineEnd: i + 1
        };

        modules.push(module);

        const nodeId = `module:${relativePath}:${moduleName}`;
        nodes.push(this.createNode(nodeId, moduleName, 'module', 2, relativePath, i + 1, i + 1, {
          visibility: isPublic ? 'public' : 'private'
        }));
      }
    }

    return modules;
  }

  private async extractUses(content: string, relativePath: string, nodes: CASNode[]): Promise<RustUse[]> {
    const uses: RustUse[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('use ')) {
        const useMatch = line.match(/use\s+(.+);/);
        if (useMatch) {
          const importPath = useMatch[1];
          const isPublic = line.includes('pub');

          // Parse imported items (simplified)
          const importedItems = importPath.split(',').map(item => item.trim());

          const use: RustUse = {
            moduleName: relativePath,
            importedItems,
            isPublic,
            lineStart: i + 1,
            lineEnd: i + 1
          };

          uses.push(use);
        }
      }
    }

    return uses;
  }

  private async extractStructs(content: string, relativePath: string, nodes: CASNode[], edges: CASEdge[]): Promise<RustStruct[]> {
    const structs: RustStruct[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();
      if (trimmedLine.includes('struct ') && !trimmedLine.startsWith('//')) {
        const structMatch = trimmedLine.match(/(?:pub\s+)?struct\s+(\w+)(?:<([^>]+)>)?/);
        if (structMatch) {
          const structName = structMatch[1];
          const generics = structMatch[2]
            ? structMatch[2].split(',').map(generic => generic.trim()).filter(Boolean)
            : [];
          const isPublic = trimmedLine.includes('pub');

          const attributes = this.extractPrecedingAttributes(lines, i);
          const documentation = this.extractDocumentation(lines, i, relativePath);

          let structEnd = i;
          if (trimmedLine.includes('{')) {
            let braceCount = 0;
            for (let j = i; j < lines.length; j++) {
              if (lines[j].includes('{')) braceCount++;
              if (lines[j].includes('}')) braceCount--;
              if (braceCount === 0 && lines[j].includes('}')) {
                structEnd = j;
                break;
              }
            }
          }

          const structBodyLines = structEnd > i ? lines.slice(i + 1, structEnd) : [];
          const fields = this.extractStructFields(structBodyLines, i + 2);

          const struct: RustStruct = {
            name: structName,
            moduleName: relativePath,
            filePath: relativePath,
            fields,
            generics,
            attributes: attributes,
            visibility: isPublic ? 'public' : 'private',
            lineStart: i + 1,
            lineEnd: structEnd + 1,
            isPublic,
            isUnion: false
          };

          structs.push(struct);

          const structType = this.determineStructType(structName, attributes, relativePath);
          const subcategories = this.determineStructSubcategories(structName, attributes, relativePath);

          const nodeId = `struct:${relativePath}:${structName}`;
          const structNode = this.createNode(nodeId, structName, structType, 3, relativePath, i + 1, structEnd + 1, {
            visibility: isPublic ? 'public' : 'private',
            fieldCount: fields.length,
            attributes: {
              fieldCount: fields.length,
              generics,
              rustAttributes: attributes,
              visibility: isPublic ? 'public' : 'private'
            },
            subcategories: subcategories
          });
          if (documentation) structNode.documentation = documentation;
          nodes.push(structNode);

          for (const field of fields) {
            const fieldId = `field:${relativePath}:${structName}:${field.name}`;
            const fieldNode = this.createNode(fieldId, field.name, 'field', 5, relativePath, field.lineNumber, field.lineNumber, {
              visibility: field.visibility,
              type: field.type,
              attributes: {
                type: field.type,
                visibility: field.visibility,
                parentStruct: structName
              }
            });
            fieldNode.parent = nodeId;
            nodes.push(fieldNode);
            edges.push(this.createEdge(
              `field_edge:${nodeId}:${fieldId}`,
              nodeId,
              fieldId,
              'has_field'
            ));
            const dependencyType = this.baseTypeName(field.type);
            const dependencyNode = nodes.find(node =>
              node.name === dependencyType &&
              node.id !== nodeId
            );
            if (dependencyNode) {
              edges.push(this.createEdge(
                `field_dependency:${nodeId}:${dependencyNode.id}:${field.name}`,
                nodeId,
                dependencyNode.id,
                'depends_on'
              ));
            }
          }

          i = structEnd;
        }
      }
    }

    return structs;
  }

  private extractPrecedingAttributes(lines: string[], structLineIndex: number): string[] {
    const attributes: string[] = [];
    for (let j = structLineIndex - 1; j >= 0; j--) {
      const prevLine = lines[j].trim();
      if (prevLine.startsWith('#[')) {
        attributes.unshift(prevLine);
      } else if (prevLine === '' || prevLine.startsWith('//')) {
        continue;
      } else {
        break;
      }
    }
    return attributes;
  }

  private extractStructFields(lines: string[], startLine: number): RustField[] {
    const fields: RustField[] = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmedLine = lines[i].replace(/\/\/.*$/, '').trim().replace(/,$/, '');
      if (!trimmedLine || trimmedLine.startsWith('//') || trimmedLine.startsWith('#[')) continue;
      if (trimmedLine.includes('::')) continue;

      const fieldMatch = trimmedLine.match(/^(pub(?:\([^)]*\))?\s+)?(\w+)\s*:\s*(.+)$/);
      if (!fieldMatch) continue;

      const isPublic = Boolean(fieldMatch[1]);
      fields.push({
        name: fieldMatch[2],
        type: fieldMatch[3].replace(/,$/, '').trim(),
        visibility: isPublic ? 'public' : 'private',
        isPublic,
        lineNumber: startLine + i
      });
    }

    return fields;
  }

  private baseTypeName(typeName: string): string {
    return typeName
      .replace(/<.*$/, '')
      .replace(/^&(?:mut\s+)?/, '')
      .replace(/^Box<|>$/g, '')
      .split('::')
      .pop()
      ?.trim() || typeName.trim();
  }

  private relativeSourcePath(file: string | undefined): string {
    if (!file) return '';
    const posix = file.split(path.sep).join('/');
    const root = this.crateManifestProjectPath ? this.crateManifestProjectPath.split(path.sep).join('/') : '';
    if (root && posix.startsWith(`${root}/`)) return posix.slice(root.length + 1);
    return posix;
  }

  private crateForSourceFile(file: string | undefined): string | undefined {
    const relative = this.relativeSourcePath(file);
    if (!relative) return undefined;
    return this.crateContextForPath(relative)?.name;
  }

  private declarationKind(node: CASNode): string {
    const separator = node.id.indexOf(':');
    return separator === -1 ? node.id : node.id.slice(0, separator);
  }

  private selectResolvedNode(candidates: CASNode[], callerFilePath: string): CASNode | undefined {
    if (candidates.length <= 1) return candidates[0];
    const callerRelative = this.relativeSourcePath(callerFilePath);
    const callerCrate = this.crateForSourceFile(callerFilePath);
    const rankOf = (node: CASNode): number => {
      const nodeRelative = this.relativeSourcePath(node.source?.file);
      if (nodeRelative === callerRelative) return 0;
      if (callerCrate && this.crateForSourceFile(node.source?.file) === callerCrate) return 1;
      return 2;
    };
    return [...candidates].sort((a, b) => {
      const rankDelta = rankOf(a) - rankOf(b);
      if (rankDelta !== 0) return rankDelta;
      const fileA = this.relativeSourcePath(a.source?.file);
      const fileB = this.relativeSourcePath(b.source?.file);
      if (fileA !== fileB) return fileA < fileB ? -1 : 1;
      const lineA = a.source?.line ?? 0;
      const lineB = b.source?.line ?? 0;
      if (lineA !== lineB) return lineA - lineB;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })[0];
  }

  private extractDocumentation(lines: string[], declarationLine: number, filePath: string): CASDocumentation | undefined {
    const docLines: Array<{ text: string; line: number }> = [];

    for (let i = declarationLine - 1; i >= 0; i--) {
      const trimmedLine = lines[i].trim();
      if (trimmedLine.startsWith('///')) {
        docLines.unshift({
          text: trimmedLine.replace(/^\/\/\/\s?/, ''),
          line: i + 1
        });
        continue;
      }
      if (trimmedLine === '' || trimmedLine.startsWith('#[')) continue;
      break;
    }

    if (docLines.length === 0) return undefined;

    const raw = docLines.map(line => line.text).join('\n');
    const contentLines = docLines.map(line => line.text);
    const summary = contentLines.find(line => line.trim() && !line.trim().startsWith('#'))?.trim();
    const descriptionLines: string[] = [];
    const parameters: CASDocumentation['parameters'] = [];
    let returns: CASDocumentation['returns'] | undefined;
    const examples: CASDocumentation['examples'] = [];
    let section: string | undefined;
    let exampleLines: string[] = [];
    let inExample = false;

    for (const line of contentLines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('# ')) {
        section = trimmed.slice(2).toLowerCase();
        continue;
      }
      if (trimmed === '```') {
        if (inExample) {
          examples.push({ code: exampleLines.join('\n'), language: 'rust' });
          exampleLines = [];
          inExample = false;
        } else {
          inExample = true;
        }
        continue;
      }
      if (inExample) {
        exampleLines.push(line);
        continue;
      }
      const itemMatch = trimmed.match(/^\*\s+`?([^`\s]+)`?\s+-\s+(.+)$/);
      if (itemMatch && section === 'arguments') {
        parameters.push({ name: itemMatch[1], description: itemMatch[2] });
        continue;
      }
      if (itemMatch && section === 'returns') {
        returns = { type: itemMatch[1], description: itemMatch[2] };
        continue;
      }
      if (!section && trimmed && trimmed !== summary) {
        descriptionLines.push(trimmed);
      }
    }

    return {
      id: `doc:${filePath}:${declarationLine + 1}`,
      format: 'rustdoc',
      type: 'rustdoc',
      raw,
      summary,
      description: descriptionLines.join('\n') || undefined,
      parameters: parameters.length > 0 ? parameters : undefined,
      returns,
      examples: examples.length > 0 ? examples : undefined,
      location: {
        start_line: docLines[0].line,
        end_line: docLines[docLines.length - 1].line
      }
    };
  }

  private determineStructType(name: string, attributes: string[], filePath: string): string {
    const nameLower = name.toLowerCase();
    const filePathLower = filePath.toLowerCase();
    const attrsJoined = attributes.join(' ').toLowerCase();

    if (attrsJoined.includes('table') || attrsJoined.includes('entity')) return 'entity';
    if (attrsJoined.includes('model')) return 'model';

    if (filePathLower.includes('/entities/') || filePathLower.includes('/entity/')) return 'entity';
    if (filePathLower.includes('/models/') || filePathLower.includes('/model/')) return 'model';
    if (filePathLower.includes('/dto/') || filePathLower.includes('/dtos/')) return 'dto';
    if (filePathLower.includes('/handlers/') || filePathLower.includes('/handler/')) return 'handler';
    if (filePathLower.includes('/services/') || filePathLower.includes('/service/')) return 'service';
    if (filePathLower.includes('/repository/') || filePathLower.includes('/repositories/')) return 'repository';

    if (nameLower.endsWith('entity')) return 'entity';
    if (nameLower.endsWith('model')) return 'model';
    if (nameLower.endsWith('dto') || nameLower.endsWith('request') || nameLower.endsWith('response')) return 'dto';
    if (nameLower.endsWith('config') || nameLower.endsWith('configuration')) return 'config';
    if (nameLower.endsWith('error') || nameLower.endsWith('err')) return 'error';
    if (nameLower.endsWith('handler')) return 'handler';
    if (nameLower.endsWith('service')) return 'service';
    if (nameLower.endsWith('repository') || nameLower.endsWith('repo')) return 'repository';
    if (nameLower.endsWith('builder')) return 'builder';
    if (nameLower.endsWith('state') || nameLower.endsWith('context')) return 'state';

    return 'struct';
  }

  private determineStructSubcategories(name: string, attributes: string[], filePath: string): string[] {
    const subcategories: string[] = ['struct'];
    const nameLower = name.toLowerCase();
    const attrsJoined = attributes.join(' ').toLowerCase();

    const structType = this.determineStructType(name, attributes, filePath);
    if (structType !== 'struct') {
      subcategories.push(structType);
    }

    if (attrsJoined.includes('serialize') || attrsJoined.includes('deserialize')) {
      subcategories.push('serializable');
    }
    if (attrsJoined.includes('table') || attrsJoined.includes('insertable') || attrsJoined.includes('queryable')) {
      subcategories.push('database');
      subcategories.push('entity');
    }
    if (attrsJoined.includes('debug') || attrsJoined.includes('clone')) {
      subcategories.push('derives');
    }

    const sensitivePatterns = ['auth', 'password', 'token', 'credential', 'secret', 'security', 'key'];
    if (sensitivePatterns.some(p => nameLower.includes(p))) {
      subcategories.push('security-sensitive');
    }

    return [...new Set(subcategories)];
  }

  private async extractEnums(content: string, relativePath: string, nodes: CASNode[]): Promise<RustEnum[]> {
    const enums: RustEnum[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('enum ') && !line.startsWith('//')) {
        const enumMatch = line.match(/(?:pub\s+)?enum\s+(\w+)/);
        if (enumMatch) {
          const enumName = enumMatch[1];
          const isPublic = line.includes('pub');

          // Find enum bounds
          let enumEnd = i;
          let braceCount = 0;
          for (let j = i; j < lines.length; j++) {
            if (lines[j].includes('{')) braceCount++;
            if (lines[j].includes('}')) braceCount--;
            if (braceCount === 0 && lines[j].includes('}')) {
              enumEnd = j;
              break;
            }
          }

          const enum_: RustEnum = {
            name: enumName,
            moduleName: relativePath,
            filePath: relativePath,
            variants: [],
            generics: [],
            attributes: [],
            visibility: isPublic ? 'public' : 'private',
            lineStart: i + 1,
            lineEnd: enumEnd + 1,
            isPublic
          };

          enums.push(enum_);

          const nodeId = `enum:${relativePath}:${enumName}`;
          nodes.push(this.createNode(nodeId, enumName, 'enum', 3, relativePath, i + 1, enumEnd + 1, {
            visibility: isPublic ? 'public' : 'private',
            variantCount: enum_.variants.length
          }));

          i = enumEnd; // Skip to end of enum
        }
      }
    }

    return enums;
  }

  private async extractTraits(content: string, relativePath: string, nodes: CASNode[]): Promise<RustTrait[]> {
    const traits: RustTrait[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('trait ') && !line.startsWith('//')) {
        const traitMatch = line.match(/(?:pub\s+)?trait\s+(\w+)/);
        if (traitMatch) {
          const traitName = traitMatch[1];
          const isPublic = line.includes('pub');

          // Find trait bounds
          let traitEnd = i;
          let braceCount = 0;
          for (let j = i; j < lines.length; j++) {
            if (lines[j].includes('{')) braceCount++;
            if (lines[j].includes('}')) braceCount--;
            if (braceCount === 0 && lines[j].includes('}')) {
              traitEnd = j;
              break;
            }
          }

          const trait: RustTrait = {
            name: traitName,
            moduleName: relativePath,
            filePath: relativePath,
            methods: [],
            associatedTypes: [],
            supertraits: [],
            generics: [],
            attributes: [],
            visibility: isPublic ? 'public' : 'private',
            lineStart: i + 1,
            lineEnd: traitEnd + 1,
            isPublic
          };

          traits.push(trait);

          const nodeId = `trait:${relativePath}:${traitName}`;
          nodes.push(this.createNode(nodeId, traitName, 'trait', 3, relativePath, i + 1, traitEnd + 1, {
            visibility: isPublic ? 'public' : 'private',
            methodCount: trait.methods.length
          }));

          i = traitEnd; // Skip to end of trait
        }
      }
    }

    return traits;
  }

  private async extractImpls(content: string, relativePath: string, nodes: CASNode[], edges: CASEdge[]): Promise<RustImpl[]> {
    const impls: RustImpl[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith('impl ')) {
        const traitImplMatch = trimmedLine.match(/impl(?:<[^>]+>)?\s+(\w+)\s+for\s+(\w+)/);
        const inherentImplMatch = trimmedLine.match(/impl(?:<[^>]+>)?\s+(\w+)/);
        const targetType = traitImplMatch?.[2] || inherentImplMatch?.[1];
        const traitName = traitImplMatch?.[1];
        if (targetType) {

          // Find impl bounds
          let implEnd = i;
          let braceCount = 0;
          for (let j = i; j < lines.length; j++) {
            if (lines[j].includes('{')) braceCount++;
            if (lines[j].includes('}')) braceCount--;
            if (braceCount === 0 && lines[j].includes('}')) {
              implEnd = j;
              break;
            }
          }

          const impl: RustImpl = {
            targetType,
            traitName,
            methods: [],
            filePath: relativePath,
            lineStart: i + 1,
            lineEnd: implEnd + 1
          };

          impls.push(impl);

          // Create node for impl block
          const nodeId = `impl:${relativePath}:${targetType}${traitName ? `:${traitName}` : ''}`;
          nodes.push(this.createNode(nodeId, `impl ${targetType}${traitName ? ` for ${traitName}` : ''}`, 'impl', 4, relativePath, i + 1, implEnd + 1, {
            targetType,
            traitName,
            attributes: {
              typeName: targetType,
              traitName
            }
          }));

	          const targetNode = nodes.find(node =>
	            node.name === targetType &&
	            ['struct', 'enum', 'trait', 'type'].includes(this.declarationKind(node)) &&
	            (node.source?.file === relativePath || node.source?.file?.endsWith(relativePath))
	          );
	          if (targetNode) {
	            edges.push(this.createEdge(
	              `impl_edge:${nodeId}:${targetNode.id}`,
	              nodeId,
	              targetNode.id,
	              'implements'
	            ));
	          }

	          if (traitName) {
	            const traitNode = nodes.find(node =>
	              node.name === traitName &&
	              node.type === 'trait' &&
	              (node.source?.file === relativePath || node.source?.file?.endsWith(relativePath))
	            );
	            if (traitNode) {
	              edges.push(this.createEdge(
	                `impl_trait:${nodeId}:${traitNode.id}`,
	                nodeId,
	                traitNode.id,
	                'implements_for'
	              ));
	            }
	          }

          i = implEnd; // Skip to end of impl
        }
      }
    }

    return impls;
  }

  private async extractFunctions(content: string, relativePath: string, nodes: CASNode[], entryPoints: CASEntryPoint[]): Promise<RustFunction[]> {
    const functions: RustFunction[] = [];
    const lines = content.split('\n');

    const implContext = this.findImplContext(lines);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();
      if (trimmedLine.includes('fn ') && !trimmedLine.startsWith('//')) {
        const fnMatch = trimmedLine.match(/(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/);
        if (fnMatch) {
          const fnName = fnMatch[1];
          const isPublic = trimmedLine.includes('pub');
          const isAsync = trimmedLine.includes('async');
          const isMain = fnName === 'main';
          const signature = this.parseFunctionSignature(trimmedLine);

          const prevLines = lines.slice(Math.max(0, i - 5), i).join('\n');
          const isTest = prevLines.includes('#[test]') || prevLines.includes('#[tokio::test]') || prevLines.includes('#[async_std::test]');
          const documentation = this.extractDocumentation(lines, i, relativePath);

          let fnEnd = i;
          let braceCount = 0;
          let foundStart = false;
          let bodyStartLine = i;
          for (let j = i; j < lines.length; j++) {
            if (lines[j].includes('{')) {
              if (!foundStart) bodyStartLine = j;
              braceCount++;
              foundStart = true;
            }
            if (lines[j].includes('}')) braceCount--;
            if (foundStart && braceCount === 0) {
              fnEnd = j;
              break;
            }
          }

	          const bodyLines = lines.slice(bodyStartLine, fnEnd + 1);
	          const body = bodyLines.join('\n');
	          const calls = this.extractCallsFromBody(body, fnName, relativePath, bodyStartLine + 1);
	          const implType = implContext.get(i + 1);

	          const func: RustFunction = {
            name: fnName,
            moduleName: relativePath,
            filePath: relativePath,
            implType,
            parameters: signature.parameters,
            returnType: signature.returnType,
            isAsync,
            isMain,
            isPublic,
            generics: [],
            attributes: [],
            body,
            calls,
            lineStart: i + 1,
            lineEnd: fnEnd + 1
          };

          functions.push(func);

          const hasExternalCalls = calls.some(c => c.isExternal);
          const hasDatabaseCalls = calls.some(c => this.isDatabaseRelatedCall(c.targetModule, c.targetFunction));
          const hasAsyncCalls = calls.some(c => c.isAsync);
          const internalCallCount = calls.filter(c => !c.isExternal).length;
          const externalCallCount = calls.filter(c => c.isExternal).length;

	          const isMethod = !!implType;
          const nodeType = isMethod ? 'method' : 'function';
          const nodeId = isMethod
            ? `method:${relativePath}:${implType}:${fnName}`
            : `function:${relativePath}:${fnName}`;

          const functionNode = this.createNode(nodeId, fnName, nodeType, 4, relativePath, i + 1, fnEnd + 1, {
            visibility: isPublic ? 'public' : 'private',
            isAsync,
            isMain,
            isTest,
            isMethod,
            implType: implType || undefined,
            parameterCount: func.parameters.length,
            has_external_calls: hasExternalCalls,
            has_database_calls: hasDatabaseCalls,
            has_async_calls: hasAsyncCalls,
            internal_call_count: internalCallCount,
            external_call_count: externalCallCount,
            call_targets: calls.map(c => c.targetFunction),
            attributes: {
              visibility: isPublic ? 'public' : 'private',
              isAsync,
              isMain,
              isTest,
              isMethod,
              implType: implType || undefined,
              parameterCount: func.parameters.length,
              call_targets: calls.map(c => c.targetFunction)
            }
          });
          functionNode.signature = {
            parameters: signature.parameters.map(parameter => ({
              name: parameter.name,
              type: parameter.type
            })),
            return_type: signature.returnType
          };
          if (implType) functionNode.parent = `struct:${relativePath}:${implType}`;
          if (documentation) functionNode.documentation = documentation;
          functionNode.implementation_status = this.determineImplementationStatus(body, prevLines, fnName);
          const todos = this.extractTodos(body, relativePath, fnName, bodyStartLine + 1, nodeId);
          if (todos.length > 0) functionNode.todos = todos;
          nodes.push(functionNode);

          if (isMain) {
            entryPoints.push(this.createEntryPoint(
              `entry:main:${relativePath}`,
              nodeId,
              'cli',
              'main',
              'Program entry point',
              undefined,
              undefined,
              this.cliEntryMetadata(relativePath)
            ));
          }

          const routeMatch = prevLines.match(/#\[(get|post|put|delete|patch)\("([^"]+)"\)\]/);
          if (routeMatch) {
            entryPoints.push(this.createEntryPoint(
              `entry:http:${relativePath}:${fnName}:${routeMatch[1]}:${routeMatch[2]}`,
              nodeId,
              'http',
              `${routeMatch[1].toUpperCase()} ${routeMatch[2]}`,
              `HTTP route handled by ${fnName}`,
              {
                method: routeMatch[1].toUpperCase(),
                path: routeMatch[2]
              },
              undefined,
              {
                framework: 'actix-web'
              },
              {
                node_id: nodeId,
                method_name: fnName,
                file: relativePath,
                line: i + 1
              }
            ));
          }

          if (isTest) {
            const isIntegrationTest = relativePath.includes('/tests/') || relativePath.startsWith('tests/');
            const testType = isIntegrationTest ? 'integration' : 'unit';
            entryPoints.push(this.createEntryPoint(
              `entry:test:${relativePath}:${fnName}`,
              nodeId,
              'test',
              fnName,
              `Test function: ${fnName}`,
              undefined,
              undefined,
              {
                test_type: testType,
                test_style: 'procedural',
                uses_mocks: this.mockallDetected,
                is_async: isAsync,
                framework: 'rust-test'
              }
            ));
          }

          i = fnEnd;
        }
      }
    }

    return functions;
  }

  private parseFunctionSignature(line: string): { parameters: RustParameter[]; returnType: string } {
    const signatureMatch = line.match(/fn\s+\w+(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?:->\s*([^{]+))?/);
    if (!signatureMatch) {
      return { parameters: [], returnType: '()' };
    }

    const parameters = signatureMatch[1].split(',')
      .map(parameter => parameter.trim())
      .filter(Boolean)
      .map((parameter, index) => {
        if (parameter === '&self' || parameter === 'self' || parameter === '&mut self') {
          return {
            name: 'self',
            type: parameter,
            isMutable: parameter.includes('mut'),
            isSelf: true,
            lineNumber: index
          };
        }

        const [namePart, ...typeParts] = parameter.split(':');
        return {
          name: namePart.replace(/^mut\s+/, '').trim(),
          type: typeParts.join(':').trim() || 'unknown',
          isMutable: namePart.includes('mut'),
          isSelf: false,
          lineNumber: index
        };
      });

    return {
      parameters,
      returnType: signatureMatch[2]?.trim() || '()'
    };
  }

  private determineImplementationStatus(body: string, precedingText: string, functionName: string): CASImplementationStatus {
    const combined = `${precedingText}\n${body}`;
    const hasTodoMarkers = /TODO|FIXME|todo!\s*\(/i.test(combined);
    const hasNotImplemented = /unimplemented!\s*\(|todo!\s*\(|panic!\s*\(/.test(combined);
    const hasStubReturns = /stub/i.test(functionName) || /"stub"|'stub'/.test(body);
    const hasDeprecated = /#\[deprecated/.test(combined);
    const hasPlaceholder = /placeholder|not implemented/i.test(combined);
    let status: CASImplementationStatus['status'] = 'complete';

    if (hasDeprecated) status = 'deprecated';
    else if (/todo!\s*\(|unimplemented!\s*\(/.test(combined)) status = 'partial';
    else if (hasStubReturns) status = 'stub';
    else if (hasTodoMarkers || hasPlaceholder) status = 'partial';

    const implementationStatus: CASImplementationStatus = {
      status,
      indicators: {
        has_todo_markers: hasTodoMarkers,
        has_not_implemented_exceptions: hasNotImplemented,
        has_stub_returns: hasStubReturns,
        has_placeholder_code: hasPlaceholder,
        has_hardcoded_values: /"\w|'\w|\b\d+\b/.test(body),
        has_commented_out_code: /^\s*\/\/\s*(pub\s+)?fn\s+/m.test(body),
        has_deprecated_markers: hasDeprecated
      },
      confidence: 0.85
    };

    if (hasDeprecated) {
      implementationStatus.deprecation = { is_deprecated: true };
    }

    return implementationStatus;
  }

  private extractTodos(body: string, filePath: string, functionName: string, startLine: number, nodeId: string): CASTodo[] {
    const todos: CASTodo[] = [];
    const lines = body.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const todoMatch = line.match(/\/\/\s*(TODO|FIXME|HACK|NOTE|WARNING|XXX|OPTIMIZE|REFACTOR):?\s*(.*)/i);
      if (todoMatch) {
        todos.push({
          id: `todo:${filePath}:${startLine + i}:${todos.length}`,
          type: todoMatch[1].toUpperCase() as CASTodo['type'],
          text: todoMatch[2].trim() || todoMatch[1],
          priority: todoMatch[1].toUpperCase() === 'FIXME' ? 'high' : 'medium',
          category: 'general',
          location: {
            file: filePath,
            line: startLine + i,
            node_id: nodeId
          },
          context: {
            function_name: functionName
          }
        });
      }

      const todoMacroMatch = line.match(/todo!\s*\(([^)]*)\)/);
      if (todoMacroMatch) {
        todos.push({
          id: `todo:${filePath}:${startLine + i}:${todos.length}`,
          type: 'TODO',
          text: todoMacroMatch[1].replace(/^["']|["']$/g, '').trim() || 'todo macro',
          priority: 'high',
          category: 'feature',
          location: {
            file: filePath,
            line: startLine + i,
            node_id: nodeId
          },
          context: {
            function_name: functionName
          }
        });
      }
    }

    return todos;
  }

  private extractCallsFromBody(body: string, callerFunction: string, callerFile: string, bodyStartLine: number): RustFunctionCall[] {
    const calls: RustFunctionCall[] = [];
    const lines = body.split('\n');
    const seenCalls = new Set<string>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      if (trimmedLine.startsWith('//') || trimmedLine.startsWith('/*') || trimmedLine.startsWith('*')) {
        continue;
      }

      const isAsyncContext = trimmedLine.includes('.await') || trimmedLine.includes('async');

      const moduleCallPattern = /(\w+)::(\w+)(?:::(\w+))?\s*\(/g;
      let match;
      while ((match = moduleCallPattern.exec(trimmedLine)) !== null) {
        const moduleName = match[1];
        const secondPart = match[2];
        const thirdPart = match[3];

        const targetFunction = thirdPart || secondPart;
        const targetModule = thirdPart ? `${moduleName}::${secondPart}` : moduleName;

        const callKey = `${targetModule}::${targetFunction}`;
        if (seenCalls.has(callKey)) continue;
        seenCalls.add(callKey);

        if (RUST_STD_MODULES.has(moduleName) || RUST_PRIMITIVES.has(moduleName)) {
          continue;
        }

        calls.push({
          callerFunction,
          callerFile,
          callerLine: bodyStartLine + i,
          targetFunction,
          targetModule,
          isExternal: true,
          isAsync: isAsyncContext,
          isMethodCall: false,
          callLine: bodyStartLine + i
        });
      }

      const methodCallPattern = /(\w+)\.(\w+)\s*\(/g;
      while ((match = methodCallPattern.exec(trimmedLine)) !== null) {
        const objectName = match[1];
        const methodName = match[2];

        if (objectName === 'self') {
          const callKey = `self::${methodName}`;
          if (seenCalls.has(callKey)) continue;
          seenCalls.add(callKey);

          calls.push({
            callerFunction,
            callerFile,
            callerLine: bodyStartLine + i,
            targetFunction: methodName,
            targetModule: undefined,
            isExternal: false,
            isAsync: isAsyncContext,
            isMethodCall: true,
            callLine: bodyStartLine + i
          });
        } else {
          const callKey = `${objectName}.${methodName}`;
          if (seenCalls.has(callKey)) continue;
          seenCalls.add(callKey);

          calls.push({
            callerFunction,
            callerFile,
            callerLine: bodyStartLine + i,
            targetFunction: methodName,
            targetModule: objectName,
            isExternal: this.isExternalObjectCall(objectName),
            isAsync: isAsyncContext,
            isMethodCall: true,
            callLine: bodyStartLine + i
          });
        }
      }

      const plainCallPattern = /(?<![.:\w])(\w+)\s*\((?![^)]*\|)/g;
      while ((match = plainCallPattern.exec(trimmedLine)) !== null) {
        const funcName = match[1];

        // A function/method DECLARATION (`fn save(...)`) is not a call to itself.
        // Without this guard the signature line yields a phantom self-call that
        // cross-links every same-name method (e.g. Logger::save -> Account::save).
        if (/\bfn\s+$/.test(trimmedLine.slice(0, match.index))) continue;

        const keywords = ['if', 'while', 'for', 'match', 'return', 'Some', 'None', 'Ok', 'Err', 'Box', 'Vec', 'println', 'print', 'eprintln', 'eprint', 'format', 'panic', 'assert', 'debug_assert', 'cfg', 'derive', 'include', 'include_str', 'include_bytes', 'env', 'option_env', 'concat', 'stringify', 'line', 'column', 'file', 'module_path'];
        if (keywords.includes(funcName)) continue;

        if (/^[A-Z]/.test(funcName) && !funcName.includes('_')) {
          continue;
        }

        const callKey = `plain::${funcName}`;
        if (seenCalls.has(callKey)) continue;
        seenCalls.add(callKey);

        calls.push({
          callerFunction,
          callerFile,
          callerLine: bodyStartLine + i,
          targetFunction: funcName,
          targetModule: undefined,
          isExternal: false,
          isAsync: isAsyncContext,
          isMethodCall: false,
          callLine: bodyStartLine + i
        });
      }
    }

    return calls;
  }

  private isExternalObjectCall(objectName: string): boolean {
    const externalIndicators = ['client', 'conn', 'db', 'pool', 'session', 'http', 'request', 'response', 'stream', 'reader', 'writer', 'file', 'socket'];
    const lowerName = objectName.toLowerCase();
    return externalIndicators.some(ind => lowerName.includes(ind));
  }

  private isDatabaseRelatedCall(module: string | undefined, functionName: string): boolean {
    if (!module) return false;
    const dbModules = ['diesel', 'sqlx', 'rusqlite', 'mongodb', 'redis', 'sea_orm', 'tokio_postgres', 'postgres'];
    const dbFunctions = ['query', 'execute', 'fetch', 'insert', 'update', 'delete', 'find', 'save', 'create', 'get', 'set'];

    const lowerModule = module.toLowerCase();
    const lowerFunc = functionName.toLowerCase();

    return dbModules.some(m => lowerModule.includes(m)) ||
           dbFunctions.some(f => lowerFunc.includes(f));
  }

  /**
   * Extract Axum routes. Unlike actix/rocket (decorator-based), axum declares
   * routes with the builder API `Router::new().route("/path", get(handler))`,
   * so they are not attached to a function as an attribute and were invisible.
   * Scan `.route("path", method(handler))` calls (including chained methods and
   * `move ||` closures) and emit one HTTP entry point per method, pointing at the
   * handler function. Local (un-nested) paths — cross-file `.nest()` prefixing is
   * not resolved, which is noted in metadata.
   */
  private extractCliSubcommands(content: string, relativePath: string, nodes: CASNode[], entryPoints: CASEntryPoint[]): void {
    if (!this.clapDetected && !this.structoptDetected) return;

    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const prevLines = lines.slice(Math.max(0, i - 10), i).join('\n');
      const hasSubcommandDerive = prevLines.includes('#[derive(') &&
        (prevLines.includes('Subcommand') || prevLines.includes('Parser') || prevLines.includes('Args'));
      const hasSubcommandAttr = prevLines.includes('#[clap(subcommand)]') || prevLines.includes('#[command(subcommand)]');

      if (hasSubcommandDerive || hasSubcommandAttr) {
        const structMatch = line.match(/(?:pub\s+)?(?:enum|struct)\s+(\w+)/);
	        if (structMatch) {
	          const name = structMatch[1];
	          const nodeId = `cli_command:${relativePath}:${name}`;
	          if (!nodes.some(node => node.id === nodeId)) {
	            nodes.push(this.createNode(nodeId, name, 'cli_command', 3, relativePath, i + 1, i + 1, {
	              commandType: line.includes('enum') ? 'subcommand_enum' : 'command_struct'
	            }));
	          }

	          entryPoints.push(this.createEntryPoint(
            `entry:cli:${relativePath}:${name}`,
            nodeId,
            'cli',
            name,
            `CLI ${line.includes('enum') ? 'subcommand enum' : 'command struct'}: ${name}`,
            undefined,
            undefined,
            {
              ...this.cliEntryMetadata(relativePath),
              command: name,
              command_type: line.includes('enum') ? 'subcommand_enum' : 'command_struct'
            }
          ));
        }
      }

      if (line.includes('enum ') && hasSubcommandDerive) {
        let enumEnd = i;
        let braceCount = 0;
        let foundStart = false;
        for (let j = i; j < lines.length; j++) {
          if (lines[j].includes('{')) {
            braceCount++;
            foundStart = true;
          }
          if (lines[j].includes('}')) braceCount--;
          if (foundStart && braceCount === 0) {
            enumEnd = j;
            break;
          }
        }

        // A variant reached here always sits inside an enum this loop already
        // gated on `hasSubcommandDerive`/`hasSubcommandAttr` (see the `if`
        // above), i.e. the enum carries the clap CLI-entry framing. Such a
        // variant is a CLI-COMMAND REGISTRATION, not a bare type-system fact,
        // so it is emitted with the same node type ('cli_command') and id
        // scheme as the sibling enum/struct-level registration node created
        // above — never 'enum_variant', which is reserved for plain enum
        // variants with no clap framing (not reachable through this branch;
        // kept only as a documented fallback should that framing ever be
        // widened to cover non-CLI enums).
        const isClapRegistration = hasSubcommandDerive || hasSubcommandAttr;
        const variantNodeType = isClapRegistration ? 'cli_command' : 'enum_variant';

        for (let j = i; j <= enumEnd; j++) {
          const variantLine = lines[j].trim();
          const variantMatch = variantLine.match(/^(\w+)(?:\s*\{|\s*\(|\s*,|\s*$)/);
          if (variantMatch && !variantLine.startsWith('enum') && !variantLine.startsWith('pub enum')) {
            const variantName = variantMatch[1];
	          if (variantName && variantName !== '{' && variantName !== '}') {
	            const variantNodeId = `${variantNodeType}:${relativePath}:${variantName}`;
	            if (!nodes.some(node => node.id === variantNodeId)) {
	              nodes.push(this.createNode(variantNodeId, variantName, variantNodeType, 4, relativePath, j + 1, j + 1, {
	                commandType: 'subcommand_variant'
	              }));
	            }
	            entryPoints.push(this.createEntryPoint(
	              `entry:cli:${relativePath}:subcommand:${variantName}`,
	              variantNodeId,
                'cli',
                variantName,
                `CLI subcommand: ${variantName}`,
                undefined,
                undefined,
                {
                  ...this.cliEntryMetadata(relativePath),
                  subcommand: variantName,
                  command_type: 'subcommand_variant'
                }
              ));
            }
          }
        }
      }
    }
  }

  private async extractConstants(content: string, relativePath: string, nodes: CASNode[]): Promise<RustConstant[]> {
    const constants: RustConstant[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if ((line.startsWith('const ') || line.startsWith('pub const ')) && !line.startsWith('//')) {
        const constMatch = line.match(/(?:pub\s+)?const\s+(\w+)/);
        if (constMatch) {
          const constName = constMatch[1];
          const isPublic = line.includes('pub');

          const constant: RustConstant = {
            name: constName,
            moduleName: relativePath,
            filePath: relativePath,
            type: 'unknown', // Would need more parsing
            value: 'unknown', // Would need more parsing
            isPublic,
            lineStart: i + 1,
            lineEnd: i + 1
          };

          constants.push(constant);

          const nodeId = `constant:${relativePath}:${constName}`;
          nodes.push(this.createNode(nodeId, constName, 'constant', 5, relativePath, i + 1, i + 1, {
            visibility: isPublic ? 'public' : 'private'
          }));
        }
      }
    }

    return constants;
  }

  private async extractStatics(content: string, relativePath: string, nodes: CASNode[]): Promise<RustStatic[]> {
    const statics: RustStatic[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if ((line.startsWith('static ') || line.startsWith('pub static ')) && !line.startsWith('//')) {
        const staticMatch = line.match(/(?:pub\s+)?static\s+(?:mut\s+)?(\w+)/);
        if (staticMatch) {
          const staticName = staticMatch[1];
          const isPublic = line.includes('pub');
          const isMutable = line.includes('mut');

          const static_: RustStatic = {
            name: staticName,
            moduleName: relativePath,
            filePath: relativePath,
            type: 'unknown', // Would need more parsing
            isMutable,
            isPublic,
            lineStart: i + 1,
            lineEnd: i + 1
          };

          statics.push(static_);

          const nodeId = `static:${relativePath}:${staticName}`;
          nodes.push(this.createNode(nodeId, staticName, 'static', 5, relativePath, i + 1, i + 1, {
            visibility: isPublic ? 'public' : 'private',
            isMutable
          }));
        }
      }
    }

    return statics;
  }

  private async extractTypes(content: string, relativePath: string, nodes: CASNode[]): Promise<RustTypeAlias[]> {
    const types: RustTypeAlias[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if ((line.startsWith('type ') || line.startsWith('pub type ')) && !line.startsWith('//')) {
        const typeMatch = line.match(/(?:pub\s+)?type\s+(\w+)/);
        if (typeMatch) {
          const typeName = typeMatch[1];
          const isPublic = line.includes('pub');

          const typeAlias: RustTypeAlias = {
            name: typeName,
            moduleName: relativePath,
            filePath: relativePath,
            targetType: 'unknown', // Would need more parsing
            generics: [],
            isPublic,
            lineStart: i + 1,
            lineEnd: i + 1
          };

          types.push(typeAlias);

          const nodeId = `type:${relativePath}:${typeName}`;
          nodes.push(this.createNode(nodeId, typeName, 'type', 5, relativePath, i + 1, i + 1, {
            visibility: isPublic ? 'public' : 'private'
          }));
        }
      }
    }

    return types;
  }

  private findImplContext(lines: string[]): Map<number, string> {
    const implContext = new Map<number, string>();
    let currentImpl: { type: string; startLine: number; endLine: number } | null = null;
    let braceCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.match(/^\s*impl(?:<[^>]+>)?\s+/)) {
        const implMatch = line.match(/impl(?:<[^>]+>)?\s+(?:(\w+)\s+for\s+)?(\w+)/);
        if (implMatch) {
          const implType = implMatch[2] || implMatch[1];
          currentImpl = { type: implType, startLine: i, endLine: i };
          braceCount = 0;
        }
      }

      if (currentImpl) {
        const openBraces = (line.match(/{/g) || []).length;
        const closeBraces = (line.match(/}/g) || []).length;
        braceCount += openBraces - closeBraces;

        if (braceCount <= 0 && line.includes('}')) {
          currentImpl.endLine = i;
          currentImpl = null;
          braceCount = 0;
        } else {
          implContext.set(i + 1, currentImpl.type);
        }
      }
    }

    return implContext;
  }

  private createRelationships(
    nodes: CASNode[],
    edges: CASEdge[],
    edgeIds: Set<string>,
    structs: RustStruct[],
    enums: RustEnum[],
    traits: RustTrait[],
    impls: RustImpl[],
    functions: RustFunction[],
    constants: RustConstant[],
    statics: RustStatic[],
    types: RustTypeAlias[]
  ): void {
    // Create relationships between structs and their implementations
    for (const struct of structs) {
      if (struct.isPublic) {
        // Create edges for public structs
        const structNode = nodes.find(n => n.id === `struct:${struct.filePath}:${struct.name}`);
        if (structNode) {
          // Add relationships to implementing functions
	          for (const func of functions) {
	            if (func.isPublic) {
	              const targetNodeId = this.findRustFunctionNodeId(nodes, func);
	              if (targetNodeId) {
	                const edgeId = `struct_func:${structNode.id}:${targetNodeId}`;
	                if (!edgeIds.has(edgeId)) {
	                  edgeIds.add(edgeId);
	                  edges.push(this.createEdge(
	                    edgeId,
	                    structNode.id,
	                    targetNodeId,
	                    'uses'
	                  ));
	                }
	              }
	            }
	          }
        }
      }
    }

    // Create trait implementation relationships
    for (const trait of traits) {
      if (trait.isPublic) {
        const traitNode = nodes.find(n => n.id === `trait:${trait.filePath}:${trait.name}`);
        if (traitNode) {
          // Find implementations
          for (const impl of impls) {
            if (impl.traitName === trait.name) {
              const implNode = nodes.find(n => n.id === `impl:${impl.filePath}:${impl.targetType}${impl.traitName ? `:${impl.traitName}` : ''}`);
              if (implNode) {
                const edgeId = `trait_impl:${traitNode.id}:${implNode.id}`;
                if (!edgeIds.has(edgeId)) {
                  edgeIds.add(edgeId);
                  edges.push(this.createEdge(
                    edgeId,
                    traitNode.id,
                    implNode.id,
                    'implemented_by'
                  ));
                }
              }
            }
          }
        }
      }
    }

    const functionNodeMap = new Map<string, string[]>();
    const nodeById = new Map<string, CASNode>();
    for (const node of nodes) {
      nodeById.set(node.id, node);
      if (node.type === 'function' || node.type === 'method') {
        const funcName = node.name;
        if (!functionNodeMap.has(funcName)) {
          functionNodeMap.set(funcName, []);
        }
        functionNodeMap.get(funcName)!.push(node.id);
      }
    }

    // A method node's owning type = the name of its parent struct/enum/trait node.
    // Used to type-resolve `recv.method()` calls to the ONE method on the
    // receiver's type, excluding same-name methods on other types (the decoy).
    const nodeIdToImplType = new Map<string, string>();
    for (const node of nodes) {
      if (node.type === 'method' && node.parent) {
        const parent = nodeById.get(node.parent);
        if (parent?.name) nodeIdToImplType.set(node.id, parent.name);
      }
    }

    for (const func of functions) {
      // Map each in-scope receiver variable to its declared base type, so a
      // `recv.method()` call resolves to recv's type only: params (`a: &Account`),
      // typed lets (`let x: T`), struct literals (`let x = T{}`), and
      // constructors (`let x = T::new()`).
      const receiverTypes = new Map<string, string>();
      for (const p of func.parameters || []) {
        if (p.isSelf || !p.type) continue;
        const t = this.baseTypeName(p.type);
        if (t && /^[A-Z]/.test(t)) receiverTypes.set(p.name, t);
      }
      if (func.body) {
        for (const m of func.body.matchAll(/\blet\s+(?:mut\s+)?(\w+)\s*:\s*([&\w:<>\s]+?)\s*[=;]/g)) {
          const t = this.baseTypeName(m[2]); if (t && /^[A-Z]/.test(t)) receiverTypes.set(m[1], t);
        }
        for (const m of func.body.matchAll(/\blet\s+(?:mut\s+)?(\w+)\s*=\s*([A-Z]\w*)\s*\{/g)) receiverTypes.set(m[1], m[2]);
        for (const m of func.body.matchAll(/\blet\s+(?:mut\s+)?(\w+)\s*=\s*([A-Z]\w*)::\w+\s*\(/g)) receiverTypes.set(m[1], m[2]);
      }
      const callerNode = nodes.find(n =>
        (n.type === 'function' || n.type === 'method') &&
        n.name === func.name &&
        n.source?.file?.includes(func.filePath)
      );
      if (!callerNode) continue;

      const callerNodeId = callerNode.id;
      const referencedTypeNodes = nodes.filter(n =>
        ['struct', 'enum', 'trait'].includes(this.declarationKind(n)) &&
        n.id !== callerNodeId &&
        func.body?.includes(`${n.name}::`)
      );
      for (const referencedTypeNode of referencedTypeNodes) {
        const edgeId = `uses:${callerNodeId}:${referencedTypeNode.id}`;
        if (!edgeIds.has(edgeId)) {
          edgeIds.add(edgeId);
          edges.push({
            ...this.createEdge(edgeId, callerNodeId, referencedTypeNode.id, 'uses'),
            aggregated_from: [`body:${func.filePath}:${func.name}`]
          } as CASEdge);
        }
      }

      for (const call of func.calls) {
        if (call.isExternal) {
          const targetType = call.targetModule ? this.baseTypeName(call.targetModule) : undefined;
          const targetNode = targetType
            ? this.selectResolvedNode(
                nodes.filter(n => ['struct', 'enum', 'trait'].includes(this.declarationKind(n)) && n.name === targetType),
                func.filePath
              )
            : undefined;
          if (targetNode) {
            const edgeId = `uses:${callerNodeId}:${targetNode.id}:${call.callLine}`;
            if (!edgeIds.has(edgeId)) {
              edgeIds.add(edgeId);
              edges.push({
                ...this.createEdge(edgeId, callerNodeId, targetNode.id, 'uses'),
                aggregated_from: [`call:${callerNodeId}:${call.targetFunction}:${call.callLine}`]
              } as CASEdge);
            }
          }
          continue;
        }

        let targetNodeIds = functionNodeMap.get(call.targetFunction) || [];
        // Type-resolve the receiver: `recv.method()` where recv's type is known
        // links ONLY to that type's method, not every same-name method. If the
        // receiver type is known and at least one method matches, narrow to it;
        // otherwise keep the name-based set (never lose a real edge).
        if (call.isMethodCall && call.targetModule) {
          const recvType = receiverTypes.get(call.targetModule);
          if (recvType) {
            const typed = targetNodeIds.filter(id => nodeIdToImplType.get(id) === recvType);
            if (typed.length) targetNodeIds = typed;
          }
        }
        for (const targetNodeId of targetNodeIds) {
          if (targetNodeId !== callerNodeId) {
            const edgeId = `call:${callerNodeId}:${targetNodeId}:${call.callLine}`;
            if (!edgeIds.has(edgeId)) {
              edgeIds.add(edgeId);
              edges.push(this.createEdge(
                edgeId,
                callerNodeId,
                targetNodeId,
                'calls'
              ));
            }
          }
        }

        if (call.isMethodCall && call.targetModule === undefined) {
          const selfMethodIds = functionNodeMap.get(call.targetFunction) || [];
          for (const selfMethodId of selfMethodIds) {
            if (selfMethodId !== callerNodeId) {
              const edgeId = `call:${callerNodeId}:${selfMethodId}:${call.callLine}`;
              if (!edgeIds.has(edgeId)) {
                edgeIds.add(edgeId);
                edges.push(this.createEdge(
                  edgeId,
                  callerNodeId,
                  selfMethodId,
                  'calls'
                ));
              }
            }
          }
        }
      }

      if (func.isPublic) {
        for (const constant of constants) {
          if (constant.isPublic) {
            const edgeId = `func_const:${callerNodeId}:${constant.filePath}:${constant.name}`;
            if (!edgeIds.has(edgeId)) {
              edgeIds.add(edgeId);
              edges.push(this.createEdge(
                edgeId,
                callerNodeId,
                `constant:${constant.filePath}:${constant.name}`,
                'uses'
              ));
            }
          }
        }

        for (const static_ of statics) {
          if (static_.isPublic) {
            const edgeId = `func_static:${callerNodeId}:${static_.filePath}:${static_.name}`;
            if (!edgeIds.has(edgeId)) {
              edgeIds.add(edgeId);
              edges.push(this.createEdge(
                edgeId,
                callerNodeId,
                `static:${static_.filePath}:${static_.name}`,
                'uses'
              ));
            }
          }
        }
      }
    }
  }

  private createMethodCalls(functions: RustFunction[], nodes: CASNode[], methodCalls: CASMethodCall[]): void {
    const functionNodeMap = new Map<string, string[]>();
    for (const node of nodes) {
      if (node.type === 'function' || node.type === 'method') {
        if (!functionNodeMap.has(node.name)) functionNodeMap.set(node.name, []);
        functionNodeMap.get(node.name)!.push(node.id);
      }
    }

    for (const func of functions) {
      const callerNode = nodes.find(node =>
        (node.type === 'function' || node.type === 'method') &&
        node.name === func.name &&
        node.source?.file?.includes(func.filePath)
      );
      if (!callerNode) continue;

      for (const call of func.calls) {
        const targetCandidates = (functionNodeMap.get(call.targetFunction) || [])
          .map(id => nodes.find(node => node.id === id))
          .filter((node): node is CASNode => Boolean(node));
        const targetNode = this.selectResolvedNode(targetCandidates, func.filePath);

        methodCalls.push({
          id: `call:${callerNode.id}:${call.targetFunction}:${call.callLine}:${methodCalls.length}`,
          caller_node: callerNode.id,
          target_node: targetNode?.id,
          call_details: {
            method_name: call.targetFunction,
            location: {
              file: call.callerFile,
              line: call.callLine,
              column: 1
            },
            call_type: call.isMethodCall ? 'method' : 'direct',
            resolution_type: targetNode ? 'static' : call.isExternal ? 'external' : 'unresolved'
          },
          execution_context: {
            is_async: call.isAsync,
            is_conditional: false,
            is_in_loop: false,
            is_recursive: call.targetFunction === func.name,
            call_depth: 1,
            conditional_depth: 0,
            loop_depth: 0,
            enclosing_function: func.name
          },
          external_details: call.isExternal ? {
            library: call.targetModule || call.targetFunction,
            module: call.targetModule,
            is_builtin: this.isStandardLibraryCall(call.targetModule || '', call.targetFunction),
            is_sdk: !this.isStandardLibraryCall(call.targetModule || '', call.targetFunction)
          } : undefined,
          performance_hints: {
            is_hot_path: false,
            is_potential_bottleneck: call.isExternal
          }
        });
      }
    }
  }

  private buildCallChains(methodCalls: CASMethodCall[]): CASCallChain[] {
    const callsByCaller = new Map<string, CASMethodCall[]>();
    for (const call of methodCalls) {
      if (!callsByCaller.has(call.caller_node)) callsByCaller.set(call.caller_node, []);
      callsByCaller.get(call.caller_node)!.push(call);
    }

    return Array.from(callsByCaller.entries()).map(([callerNode, calls], index) => {
      const hasExternalCalls = calls.some(call => call.call_details.resolution_type === 'external');
      return {
        id: `chain:rust:${index}:${callerNode}`,
        chain_type: hasExternalCalls ? 'entry-to-exit' : 'dead-end',
        entry_point: {
          node_id: callerNode,
          method_name: calls[0]?.execution_context.enclosing_function || callerNode
        },
        exit_point: hasExternalCalls ? {
          node_id: calls[calls.length - 1]?.target_node,
          method_name: calls[calls.length - 1]?.call_details.method_name || 'external'
        } : undefined,
        call_path: calls.map((call, callIndex) => ({
          call_id: call.id,
          node_id: call.target_node || call.caller_node,
          method_name: call.call_details.method_name,
          depth: callIndex + 1
        })),
        characteristics: {
          total_calls: calls.length,
          max_depth: calls.length,
          has_external_calls: hasExternalCalls,
          has_database_calls: calls.some(call => {
            const library = call.external_details?.library?.toLowerCase() || '';
            return ['diesel', 'sqlx', 'rusqlite', 'mongodb', 'redis'].includes(library);
          }),
          has_async_calls: calls.some(call => call.execution_context.is_async),
          is_circular: false,
          is_recursive: calls.some(call => call.execution_context.is_recursive),
          complexity_score: Math.max(1, calls.length)
        },
        risk_analysis: {
          risk_level: hasExternalCalls ? 'medium' : 'low',
          risk_factors: hasExternalCalls ? ['external-call'] : []
        }
      };
    });
  }

  private createExitPointsForLibraries(libraries: any[], exitPoints: CASExitPoint[], nodes: CASNode[]): void {
  }

  private createExitPointsFromFunctions(functions: RustFunction[], filePath: string, exitPoints: CASExitPoint[], nodes: CASNode[]): void {
    const seenCalls = new Set<string>();
    // Guard against emitting the same exit-point id twice within a single run.
    // On cargo workspaces the same project-relative path is linked from multiple
    // crates, which previously produced duplicate-id PARTIAL_ANALYSIS errors.
    const existingExitPointIds = new Set(exitPoints.map(ep => ep.id));
    const pushExitPoint = (ep: CASExitPoint): void => {
      if (existingExitPointIds.has(ep.id)) return;
      existingExitPointIds.add(ep.id);
      exitPoints.push(ep);
    };

    for (const func of functions) {
      const sourceNodeId = this.findRustFunctionNodeId(nodes, func);
      if (!sourceNodeId) continue;

      for (const call of this.extractReqwestHttpCalls(func)) {
        const uniqueKey = `${sourceNodeId}:reqwest:${call.method}:${call.endpoint}`;
        if (seenCalls.has(uniqueKey)) continue;
        seenCalls.add(uniqueKey);
        const exitPointId = `reqwest_call:${filePath}:${call.line}:${call.method}:${call.endpoint}`.replace(/[^a-zA-Z0-9_:/.-]/g, '_');
        pushExitPoint(this.createExitPoint(
          exitPointId,
          sourceNodeId,
          'api',
          `${call.method.toUpperCase()} ${call.endpoint}`,
          `Reqwest HTTP client call to ${call.endpoint}`,
          {
            service_id: call.serviceAlias || 'reqwest',
            endpoint: call.endpoint,
            resource: call.endpoint,
          },
          {
            method: call.method.toUpperCase(),
            action: call.method,
            async: func.isAsync,
          },
          {
            library: 'reqwest',
            service_aliases: call.serviceAlias ? [call.serviceAlias] : [],
            caller_function: func.name,
            call_line: call.line,
          }
        ));
      }

      for (const call of func.calls) {
        if (!call.isExternal) continue;
        if (!call.targetModule) continue;

        const moduleParts = call.targetModule.split('::');
        const moduleName = moduleParts[0];
        const functionName = call.targetFunction;
        const callKey = `${call.targetModule}::${functionName}`;

        const uniqueKey = `${sourceNodeId}:${callKey}`;
        if (seenCalls.has(uniqueKey)) continue;
        if (this.isStandardLibraryCall(moduleName, functionName)) continue;

        seenCalls.add(uniqueKey);
        const category = this.categorizeExitPoint(moduleName, functionName);
        const exitPointId = `ext_call:${filePath}:${call.callLine}:${callKey}`.replace(/[^a-zA-Z0-9_:/.-]/g, '_');

        pushExitPoint(this.createExitPoint(
          exitPointId,
          sourceNodeId,
          category.type,
          callKey,
          `${category.library || moduleName} call: ${callKey}`,
          { sdk: category.library || moduleName },
          { action: 'external_call' },
          {
            library: category.library || moduleName,
            module: call.targetModule,
            function: functionName,
            caller_function: func.name,
            call_line: call.callLine,
            is_async: call.isAsync
          }
        ));
      }
    }
  }

  private extractReqwestHttpCalls(func: RustFunction): Array<{ method: string; endpoint: string; serviceAlias?: string; line: number }> {
    const body = func.body || '';
    if (!body || !/(?:\.get|\.post|\.put|\.patch|\.delete|\.head)\s*\(|\.url\s*(?:\.\s*clone\s*\(\s*\))?\s*\.\s*join\s*\(/.test(body)) return [];
    const calls: Array<{ method: string; endpoint: string; serviceAlias?: string; line: number }> = [];
    const localServiceAlias = this.serviceAliasFromRustFile(func.filePath);
    const directUrlCall = /\.(get|post|put|patch|delete|head)\s*\(\s*["']([^"']+)["']/g;
    const joinCall = /\.(get|post|put|patch|delete|head)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.\s*clone\s*\(\s*\))?\s*\.\s*join\s*\(\s*["']([^"']+)["']/g;
    const localJoinThenCall = /\blet\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*self\.url\s*(?:\.\s*clone\s*\(\s*\))?\s*\.\s*join\s*\(\s*(?:&?\s*format!\s*\(\s*)?["']([^"']+)["'][\s\S]{0,900}?\.(get|post|put|patch|delete|head)\s*\(\s*\1(?:\.as_str\s*\(\s*\))?/g;
    let match: RegExpExecArray | null;

    while ((match = directUrlCall.exec(body)) !== null) {
      if (!/^https?:\/\//.test(match[2])) continue;
      calls.push({
        method: match[1],
        endpoint: match[2],
        serviceAlias: this.serviceAliasFromEndpoint(match[2]),
        line: func.lineStart + body.slice(0, match.index).split(/\r?\n/).length - 1,
      });
    }

    while ((match = joinCall.exec(body)) !== null) {
      const serviceAlias = this.serviceAliasFromVariable(match[2]) || localServiceAlias;
      const pathPart = match[3];
      calls.push({
        method: match[1],
        endpoint: serviceAlias ? `http://${serviceAlias}/${pathPart.replace(/^\/+/, '')}` : `/${pathPart.replace(/^\/+/, '')}`,
        serviceAlias,
        line: func.lineStart + body.slice(0, match.index).split(/\r?\n/).length - 1,
      });
    }

    while ((match = localJoinThenCall.exec(body)) !== null) {
      const pathPart = match[2];
      calls.push({
        method: match[3],
        endpoint: localServiceAlias ? `http://${localServiceAlias}/${pathPart.replace(/^\/+/, '')}` : `/${pathPart.replace(/^\/+/, '')}`,
        serviceAlias: localServiceAlias,
        line: func.lineStart + body.slice(0, match.index).split(/\r?\n/).length - 1,
      });
    }

    return calls;
  }

  private serviceAliasFromVariable(variable: string): string | undefined {
    const normalized = variable.replace(/_(url|base|host|endpoint)$/i, '').toLowerCase();
    return this.normalizeServiceAlias(normalized);
  }

  private serviceAliasFromRustFile(filePath: string): string | undefined {
    const normalized = filePath.toLowerCase().replace(/\\/g, '/');
    const parts = normalized.split('/');
    const namedSegment = parts.find((part, index) =>
      ['bin', 'apps', 'services', 'crates', 'packages'].includes(parts[index - 1] || '') &&
      /[a-z0-9]/.test(part)
    );
    return this.normalizeServiceAlias(namedSegment || path.basename(normalized, path.extname(normalized)));
  }

  private normalizeServiceAlias(value: string | undefined): string | undefined {
    const normalized = String(value || '')
      .replace(/[_\s]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
    if (!normalized || /^(url|base|host|endpoint|api|client|server|service|src|lib|main|mod)$/.test(normalized)) return undefined;
    if (/^(admin|user|internal|public|mcp)$/.test(normalized)) return `${normalized}-api`;
    if (/^(admin|user|internal|public|mcp)-api$/.test(normalized)) return normalized;
    if (/(api|server|service|worker|agent|client|coordinator|gateway|broker|relay|daemon)$/.test(normalized)) return normalized;
    return undefined;
  }

  private serviceAliasFromEndpoint(endpoint: string): string | undefined {
    return endpoint.match(/^https?:\/\/([A-Za-z0-9_.-]+)/)?.[1];
  }

  private findRustFunctionNodeId(nodes: CASNode[], func: RustFunction): string | undefined {
    const expectedId = func.implType
      ? `method:${func.filePath}:${func.implType}:${func.name}`
      : `function:${func.filePath}:${func.name}`;
    const exact = nodes.find(node => node.id === expectedId);
    if (exact) return exact.id;

    return nodes.find(node =>
      node.name === func.name &&
      (node.type === 'function' || node.type === 'method') &&
      (node.source?.file === func.filePath || node.source?.file?.endsWith(func.filePath))
    )?.id;
  }

  private isStandardLibraryCall(moduleName: string, functionName: string): boolean {
    if (RUST_STD_MODULES.has(moduleName)) return true;
    if (RUST_STD_MODULES.has(functionName)) return true;
    if (RUST_PRIMITIVES.has(moduleName)) return true;

    const stdPatterns = [
      /^(self|super|crate)$/,
      /^[a-z]$/, // Single lowercase letter (generic)
      /^(as_|to_|into_|from_|try_|is_|has_|get_|set_)/,
    ];

    for (const pattern of stdPatterns) {
      if (pattern.test(moduleName)) return true;
    }

    const internalModules = ['ipaddr', 'RateLimiter'];
    if (internalModules.includes(moduleName)) return true;

    return false;
  }

  private categorizeExitPoint(moduleName: string, functionName: string): ExitPointCategory {
    if (EXIT_POINT_CATEGORIES[moduleName]) {
      return EXIT_POINT_CATEGORIES[moduleName];
    }
    if (EXIT_POINT_CATEGORIES[functionName]) {
      return EXIT_POINT_CATEGORIES[functionName];
    }

    if (['get', 'post', 'put', 'delete', 'patch', 'request', 'send', 'fetch'].includes(functionName.toLowerCase())) {
      return { type: 'api', library: moduleName };
    }
    if (['query', 'execute', 'insert', 'update', 'delete', 'select', 'find'].includes(functionName.toLowerCase())) {
      return { type: 'database', library: moduleName };
    }
    if (['connect', 'bind', 'listen', 'accept', 'read', 'write'].includes(functionName.toLowerCase())) {
      return { type: 'api', library: moduleName };
    }
    if (['open', 'create', 'read', 'write', 'remove', 'rename', 'copy'].includes(functionName.toLowerCase())) {
      return { type: 'file', library: moduleName };
    }
    if (['publish', 'subscribe', 'send', 'receive', 'produce', 'consume'].includes(functionName.toLowerCase())) {
      return { type: 'message', library: moduleName };
    }

    return { type: 'sdk', library: moduleName };
  }

  private detectPatterns(nodes: CASNode[]): CASPattern[] {
    const patterns: CASPattern[] = [];

    if (this.clapDetected || this.structoptDetected) {
      const cliNodes = nodes.filter(n =>
        n.metadata?.attributes?.has_clap_derive ||
        n.name.toLowerCase().includes('cli') ||
        n.name.toLowerCase().includes('args') ||
        n.name.toLowerCase().includes('command')
      );
      patterns.push({
        id: 'pattern:rust:cli',
        type: 'architectural-pattern',
        name: 'CLI Application Pattern',
        description: `Command-line application using ${this.clapDetected ? 'clap' : 'structopt'} for argument parsing`,
        confidence: 0.95,
        instances: cliNodes.map(n => n.id),
        metadata: {
          framework_specific: true,
          language_specific: true,
          benefits: ['Type-safe argument parsing', 'Auto-generated help', 'Subcommand support']
        }
      });
    }

    if (this.tokioDetected || this.asyncStdDetected) {
      const asyncNodes = nodes.filter(n =>
        n.metadata?.is_async ||
        n.name.includes('async') ||
        n.metadata?.attributes?.uses_tokio
      );
      patterns.push({
        id: 'pattern:rust:async-runtime',
        type: 'architectural-pattern',
        name: 'Async Runtime Pattern',
        description: `Asynchronous application using ${this.tokioDetected ? 'tokio' : 'async-std'} runtime`,
        confidence: 0.9,
        instances: asyncNodes.map(n => n.id),
        metadata: {
          framework_specific: true,
          language_specific: true,
          benefits: ['Non-blocking I/O', 'Concurrent execution', 'Resource efficiency']
        }
      });
    }

    const builderStructs = nodes.filter(n =>
      this.declarationKind(n) === 'struct' &&
      (n.name.endsWith('Builder') || n.name.endsWith('Config') || n.name.endsWith('Options'))
    );
    if (builderStructs.length > 0) {
      patterns.push({
        id: 'pattern:rust:builder',
        type: 'design-pattern',
        name: 'Builder Pattern',
        description: 'Fluent builder pattern for constructing complex objects',
        confidence: 0.85,
        instances: builderStructs.map(n => n.id),
        metadata: {
          language_specific: true,
          benefits: ['Fluent API', 'Compile-time validation', 'Readable construction']
        }
      });
    }

    const errorTypes = nodes.filter(n =>
      ['enum', 'struct'].includes(this.declarationKind(n)) &&
      (n.name.endsWith('Error') || n.name.endsWith('Err') || n.name === 'Error')
    );
    if (errorTypes.length > 0) {
      patterns.push({
        id: 'pattern:rust:error-handling',
        type: 'design-pattern',
        name: 'Custom Error Types',
        description: 'Custom error types implementing std::error::Error',
        confidence: 0.9,
        instances: errorTypes.map(n => n.id),
        metadata: {
          language_specific: true,
          benefits: ['Type-safe error handling', 'Rich error context', 'Error propagation with ?']
        }
      });
    }

    const traits = nodes.filter(n => n.type === 'trait');
    if (traits.length > 0) {
      patterns.push({
        id: 'pattern:rust:trait-based-design',
        type: 'design-pattern',
        name: 'Trait-Based Polymorphism',
        description: 'Using traits for abstraction and polymorphism',
        confidence: 0.85,
        instances: traits.map(n => n.id),
        metadata: {
          language_specific: true,
          benefits: ['Zero-cost abstractions', 'Static dispatch', 'Compile-time polymorphism']
        }
      });
    }

    const serviceTraits = traits.filter(n => n.name.endsWith('Service'));
    const serviceStructs = nodes.filter(n => this.declarationKind(n) === 'struct' && n.name.endsWith('Service'));
    if (serviceTraits.length > 0 || serviceStructs.length > 0) {
      const variations = [];
      if (serviceTraits.length > 0) {
        variations.push({
          id: 'trait-based',
          implementation: 'trait',
          description: 'Service contracts are expressed with Rust traits',
          instances: serviceTraits.map(n => n.id),
          percentage: Math.round((serviceTraits.length / Math.max(1, serviceTraits.length + serviceStructs.length)) * 100),
          characteristics: { uses_traits: true }
        });
      }
      if (serviceStructs.length > 0) {
        variations.push({
          id: 'struct-based',
          implementation: 'struct',
          description: 'Services are implemented directly as structs',
          instances: serviceStructs.map(n => n.id),
          percentage: Math.round((serviceStructs.length / Math.max(1, serviceTraits.length + serviceStructs.length)) * 100),
          characteristics: { uses_structs: true }
        });
      }
      patterns.push({
        id: 'service-layer-pattern',
        type: 'architectural-pattern',
        name: 'Service Layer',
        description: 'Application behavior is grouped behind service contracts or service structs',
        confidence: 0.8,
        instances: [...serviceTraits, ...serviceStructs].map(n => n.id),
        variations,
        metadata: {
          language_specific: true
        }
      });
    }

    const resultFunctions = nodes.filter(n =>
      (n.type === 'function' || n.type === 'method') &&
      n.signature?.return_type?.includes('Result')
    );
    const panicFunctions = nodes.filter(n =>
      (n.type === 'function' || n.type === 'method') &&
      Boolean((n.implementation_status?.indicators as any)?.has_not_implemented_exceptions)
    );
    const plainFunctions = nodes.filter(n =>
      (n.type === 'function' || n.type === 'method') &&
      !n.signature?.return_type?.includes('Result') &&
      !(n.implementation_status?.indicators as any)?.has_not_implemented_exceptions
    );
    if (resultFunctions.length > 0 || panicFunctions.length > 0 || plainFunctions.length > 0) {
      patterns.push({
        id: 'error-handling-pattern',
        type: 'design-pattern',
        name: 'Error Handling Styles',
        description: 'Rust error handling approaches observed in functions and methods',
        confidence: 0.75,
        instances: [...resultFunctions, ...panicFunctions, ...plainFunctions].map(n => n.id),
        variations: [
          {
            id: 'result-based',
            implementation: 'Result',
            description: 'Functions return Result for recoverable errors',
            instances: resultFunctions.map(n => n.id),
            percentage: Math.round((resultFunctions.length / Math.max(1, resultFunctions.length + panicFunctions.length + plainFunctions.length)) * 100),
            characteristics: { uses_result: true }
          },
          {
            id: 'panic-based',
            implementation: 'panic',
            description: 'Functions use panic-style failure',
            instances: panicFunctions.map(n => n.id),
            percentage: Math.round((panicFunctions.length / Math.max(1, resultFunctions.length + panicFunctions.length + plainFunctions.length)) * 100),
            characteristics: { uses_panic: true }
          },
          {
            id: 'implicit-success',
            implementation: 'plain-return',
            description: 'Functions return success values without explicit error channel',
            instances: plainFunctions.map(n => n.id),
            percentage: Math.round((plainFunctions.length / Math.max(1, resultFunctions.length + panicFunctions.length + plainFunctions.length)) * 100),
            characteristics: { no_explicit_error_channel: true }
          }
        ],
        metadata: {
          language_specific: true
        }
      });
    }

    if (this.serdeDetected) {
      const serdeNodes = nodes.filter(n =>
        n.metadata?.attributes?.has_serde_derive ||
        n.metadata?.annotations?.includes('Serialize') ||
        n.metadata?.annotations?.includes('Deserialize')
      );
      patterns.push({
        id: 'pattern:rust:serde-serialization',
        type: 'design-pattern',
        name: 'Serde Serialization',
        description: 'Data serialization/deserialization using serde',
        confidence: 0.95,
        instances: serdeNodes.map(n => n.id),
        metadata: {
          framework_specific: true,
          benefits: ['Format-agnostic', 'Derive macros', 'High performance']
        }
      });
    }

    const moduleNodes = nodes.filter(n => n.type === 'module');
    if (moduleNodes.length >= 3) {
      patterns.push({
        id: 'pattern:rust:module-organization',
        type: 'architectural-pattern',
        name: 'Module Organization',
        description: 'Organized module hierarchy for code organization',
        confidence: 0.8,
        instances: moduleNodes.map(n => n.id),
        metadata: {
          language_specific: true,
          benefits: ['Code organization', 'Visibility control', 'Namespace management']
        }
      });
    }

    return patterns;
  }

  private generatePerspectives(nodes: CASNode[]): CASPerspective[] {
    const perspectives: CASPerspective[] = [];

    perspectives.push({
      id: 'perspective:rust:module-hierarchy',
      name: 'Module Hierarchy',
      description: 'View of the crate module structure',
      analyzer_id: this.analyzerId,
      type: 'structure',
      connection_rules: {
        visible_node_types: ['module', 'file', 'crate'],
        relevant_edge_types: ['contains', 'imports', 'exports']
      },
      layout_hints: {
        style: 'hierarchical',
        direction: 'TB',
        group_by: 'module'
      }
    });

    const hasTraits = nodes.some(n => n.type === 'trait');
    if (hasTraits) {
      perspectives.push({
        id: 'perspective:rust:trait-implementations',
        name: 'Trait Implementations',
        description: 'View of traits and their implementations',
        analyzer_id: this.analyzerId,
        type: 'structure',
        connection_rules: {
          visible_node_types: ['trait', 'struct', 'enum', 'impl'],
          relevant_edge_types: ['implements', 'defines']
        },
        layout_hints: {
          style: 'hierarchical',
          direction: 'TB'
        }
      });
    }

    perspectives.push({
      id: 'perspective:rust:data-flow',
      name: 'Data Flow',
      description: 'View of data movement through functions and modules',
      analyzer_id: this.analyzerId,
      type: 'flow',
      connection_rules: {
        visible_node_types: ['function', 'method', 'struct', 'enum'],
        relevant_edge_types: ['calls', 'returns', 'uses']
      },
      layout_hints: {
        style: 'hierarchical',
        direction: 'LR'
      }
    });

    if (this.clapDetected || this.structoptDetected) {
      perspectives.push({
        id: 'perspective:rust:cli-structure',
        name: 'CLI Structure',
        description: 'View of CLI commands and subcommands',
        analyzer_id: this.analyzerId,
        type: 'structure',
        connection_rules: {
          visible_node_types: ['struct', 'enum', 'function', 'entry_point'],
          relevant_edge_types: ['contains', 'calls']
        },
        layout_hints: {
          style: 'hierarchical',
          direction: 'TB',
          group_by: 'subcommand'
        }
      });
    }

    if (this.dieselDetected || this.sqlxDetected) {
      perspectives.push({
        id: 'perspective:rust:data-access',
        name: 'Data Access Layer',
        description: 'View of database interactions and models',
        analyzer_id: this.analyzerId,
        type: 'data',
        connection_rules: {
          visible_node_types: ['struct', 'function', 'method', 'exit_point'],
          relevant_edge_types: ['queries', 'writes', 'reads']
        },
        layout_hints: {
          style: 'hierarchical',
          direction: 'LR'
        }
      });
    }

    return perspectives;
  }

  private async getRustVersion(projectPath: string): Promise<string> {
    void projectPath;
    if (detectedRustVersion !== undefined) return detectedRustVersion;
    try {
      const { execSync } = require('child_process');
      const version = execSync('rustc --version', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      const match = version.match(/rustc (\d+\.\d+\.\d+)/);
      detectedRustVersion = match ? match[1] : 'unknown';
    } catch {
      detectedRustVersion = 'unknown';
    }
    return detectedRustVersion || 'unknown';
  }
}
