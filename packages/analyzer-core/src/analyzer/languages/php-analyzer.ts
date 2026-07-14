import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  CASDocumentation, CASComment, CASTodo, CASImplementationStatus, FileAnalysisResult
} from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import { detectSyntaxDegradation } from '../core/syntax-degradation';
import { isPhpPureBuiltinFunction } from '../core/language-builtins';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';
import { TreeSitterParser } from '../core/tree-sitter-parser';
import type { PHPASTNode } from '../core/ast-types';
import * as path from 'path';

interface PHPClass {
  name: string;
  namespace: string;
  filePath: string;
  modifiers: string[];
  extendsClass?: string;
  implementsInterfaces: string[];
  properties: PHPProperty[];
  methods: PHPMethod[];
  constants: PHPConstant[];
  traits: string[];
  docComment?: string;
  lineStart: number;
  lineEnd: number;
  isAbstract: boolean;
  isFinal: boolean;
}

interface PHPInterface {
  name: string;
  namespace: string;
  filePath: string;
  extendsInterfaces: string[];
  methods: PHPMethod[];
  constants: PHPConstant[];
  docComment?: string;
  lineStart: number;
  lineEnd: number;
}

interface PHPTrait {
  name: string;
  namespace: string;
  filePath: string;
  properties: PHPProperty[];
  methods: PHPMethod[];
  usedTraits: string[];
  docComment?: string;
  lineStart: number;
  lineEnd: number;
}

interface PHPMethod {
  name: string;
  visibility: string;
  modifiers: string[];
  parameters: PHPParameter[];
  returnType?: string;
  docComment?: string;
  lineStart: number;
  lineEnd: number;
  isAbstract: boolean;
  isFinal: boolean;
  isStatic: boolean;
  isConstructor: boolean;
  isDestructor: boolean;
}

interface PHPProperty {
  name: string;
  visibility: string;
  modifiers: string[];
  type?: string;
  defaultValue?: string;
  docComment?: string;
  lineNumber: number;
  isStatic: boolean;
  isReadonly: boolean;
}

interface PHPParameter {
  name: string;
  type?: string;
  defaultValue?: string;
  isVariadic: boolean;
  isReference: boolean;
  isNullable: boolean;
}

interface PHPFunction {
  name: string;
  namespace: string;
  filePath: string;
  parameters: PHPParameter[];
  returnType?: string;
  docComment?: string;
  lineStart: number;
  lineEnd: number;
}

interface PHPConstant {
  name: string;
  value: string;
  visibility?: string;
  docComment?: string;
  lineNumber: number;
  isClassConstant: boolean;
}

interface PHPVariable {
  name: string;
  scope: 'global' | 'local' | 'static';
  type?: string;
  defaultValue?: string;
  lineNumber: number;
}


interface PHPUse {
  namespace: string;
  alias?: string;
  type: 'class' | 'function' | 'const';
  lineNumber: number;
}

interface PHPEnum {
  name: string;
  namespace: string;
  filePath: string;
  backingType?: string;
  cases: PHPEnumCase[];
  methods: PHPMethod[];
  constants: PHPConstant[];
  implementsInterfaces: string[];
  traits: string[];
  docComment?: string;
  lineStart: number;
  lineEnd: number;
}

interface PHPEnumCase {
  name: string;
  value?: string;
  docComment?: string;
  lineNumber: number;
}

/**
 * Per-class type facts used by call-graph resolution: what a class extends /
 * implements / uses, and the declared type of each property (typed
 * declarations, PHP 8 promoted constructor params, constructor-assignment
 * injection, and `@var` docblocks). All names are namespace-stripped base
 * names — the analyzer's node lookup tables are keyed the same way.
 */
interface PhpClassTypeInfo {
  name: string;
  isInterface: boolean;
  isAbstract: boolean;
  extendsName?: string;
  interfaces: string[];
  traits: string[];
  propertyTypes: Map<string, string>;
  /** Declared return types (base names) — lets `$x = $this->repo->createQb()` type $x. */
  methodReturnTypes: Map<string, string>;
}

/**
 * Project-wide type index for evidence-gated call resolution: Symfony DI
 * (interface -> unique implementation, or an explicit services.yaml alias)
 * and Doctrine (entity -> custom repository class from
 * `repositoryClass:`/`parent::__construct($registry, Entity::class)`).
 */
interface PhpTypeIndex {
  classInfoByName: Map<string, PhpClassTypeInfo>;
  implsByInterface: Map<string, string[]>;
  repoClassByEntity: Map<string, string>;
  bindingByInterface: Map<string, string>;
}

export class PHPAnalyzer extends BaseAnalyzer {
  private laravelFrameworkDetected = false;
  private symfonyFrameworkDetected = false;
  private codeIgniterFrameworkDetected = false;
  private cakePHPFrameworkDetected = false;
  private drupalFrameworkDetected = false;
  private wordPressFrameworkDetected = false;
  private composerProject = false;
  private astRunner: TreeSitterParser;
  private astCache = new Map<string, PHPASTNode>();
  private fileContentCache = new Map<string, string>();

  constructor() {
    super(
      'php',
      'PHP Language Analyzer',
      '1.0.0',
      'language'
    );
    this.astRunner = new TreeSitterParser();
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const ignore = this.getPHPIgnorePatterns({ projectPath });
      const phpFiles = await glob(['**/*.php'], {
        cwd: projectPath,
        ignore,
        nodir: true
      });

      const composerFiles = await glob(['composer.json', 'composer.lock'], {
        cwd: projectPath,
        nodir: true
      });

      return phpFiles.length > 0 || composerFiles.length > 0;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await glob(['**/*.php'], {
      cwd: projectPath,
      ignore: this.getPHPIgnorePatterns({ projectPath }),
      nodir: true
    });
    return files.sort();
  }

  private getPHPIgnorePatterns(context: AnalysisContext): string[] {
    return [
      ...this.getIgnorePatterns(context),
      '**/storage/framework/**',
      '**/storage/logs/**',
      '**/bootstrap/cache/**',
      '**/cache/**'
    ];
  }

  private async readFileCached(fullPath: string): Promise<string> {
    const cached = this.fileContentCache.get(fullPath);
    if (cached !== undefined) return cached;
    const content = await fs.readFile(fullPath, 'utf-8');
    this.fileContentCache.set(fullPath, content);
    return content;
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const namespaces = new Map<string, string[]>();
    const content = await this.readFileCached(context.filePath);
    const stat = await fs.stat(context.filePath);

    await this.detectProjectType(context.projectPath);
    await this.analyzePHPFile(context.filePath, context.relativePath, nodes, edges, entryPoints, exitPoints, namespaces, context);
    this.detectFrameworkPatterns(nodes, edges, entryPoints);
    this.buildInheritanceRelationships(nodes, edges);
    await this.analyzeCallGraphFastFallback(
      context.projectPath,
      [context.relativePath],
      nodes,
      edges,
      exitPoints,
      nodes.filter(n => n.type === 'method' || n.type === 'function'),
      nodes.filter(n => n.type === 'class' || n.type === 'interface' || n.type === 'trait')
    );

    const imports = this.extractUses(content).map(use => use.namespace);
    const exports = nodes
      .filter(node => ['class', 'interface', 'trait', 'enum', 'function', 'method', 'property', 'constant'].includes(node.type))
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
    this.resetAnalysisWarnings();
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const libraries: any[] = [];

    try {
      this.astCache.clear();
      this.fileContentCache.clear();
      await this.detectProjectType(context.projectPath);
      await this.extractDependencies(context.projectPath, libraries);

      const phpFiles = await glob(['**/*.php'], {
        cwd: context.projectPath,
        ignore: this.getPHPIgnorePatterns(context),
        nodir: true
      });
      phpFiles.sort();

      const namespaces = new Map<string, string[]>();

      for (const file of phpFiles) {
        const fullPath = `${context.projectPath}/${file}`;
        await this.analyzePHPFile(fullPath, file, nodes, edges, entryPoints, exitPoints, namespaces, context);
      }

      this.buildNamespaceHierarchy(namespaces, nodes, edges);
      this.detectFrameworkPatterns(nodes, edges, entryPoints);
      this.buildInheritanceRelationships(nodes, edges);

      await this.analyzeCallGraph(context.projectPath, nodes, edges, exitPoints);

      const warnings = this.collectAnalysisWarnings();
      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        ...(warnings.length > 0 ? { warnings } : {}),
        framework_specific: {
          language: 'php',
          laravelFramework: this.laravelFrameworkDetected,
          symfonyFramework: this.symfonyFrameworkDetected,
          codeIgniterFramework: this.codeIgniterFrameworkDetected,
          cakePHPFramework: this.cakePHPFrameworkDetected,
          drupalFramework: this.drupalFrameworkDetected,
          wordPressFramework: this.wordPressFrameworkDetected,
          packageManager: this.composerProject ? 'composer' : 'unknown',
          libraries,
          filesAnalyzed: phpFiles.length,
          namespacesFound: namespaces.size
        }
      });

    } catch (error) {
      throw new AnalyzerError(
        `PHP analysis failed: ${(error as Error).message}`,
        'PHP_ANALYSIS_ERROR'
      );
    }
  }

  private async detectProjectType(projectPath: string): Promise<void> {
    const composerJsonPath = `${projectPath}/composer.json`;

    this.composerProject = await fs.pathExists(composerJsonPath);

    if (this.composerProject) {
      try {
        const composerContent = await fs.readFile(composerJsonPath, 'utf-8');
        this.detectFrameworks(composerContent);
      } catch (error) {
        console.warn('Failed to read composer.json:', error);
      }
    }

    await this.detectFrameworksByFiles(projectPath);
  }

  private detectFrameworks(content: string): void {
    this.laravelFrameworkDetected = this.laravelFrameworkDetected ||
      content.includes('laravel/framework') || content.includes('illuminate/');

    this.symfonyFrameworkDetected = this.symfonyFrameworkDetected ||
      content.includes('symfony/symfony') || content.includes('symfony/framework');

    this.codeIgniterFrameworkDetected = this.codeIgniterFrameworkDetected ||
      content.includes('codeigniter/framework') || content.includes('codeigniter4/framework');

    this.cakePHPFrameworkDetected = this.cakePHPFrameworkDetected ||
      content.includes('cakephp/cakephp');

    this.drupalFrameworkDetected = this.drupalFrameworkDetected ||
      content.includes('drupal/core') || content.includes('drupal/drupal');

    this.wordPressFrameworkDetected = this.wordPressFrameworkDetected ||
      content.includes('wordpress/wordpress') || content.includes('johnpbloch/wordpress');
  }

  private async detectFrameworksByFiles(projectPath: string): Promise<void> {
    const artisanPath = `${projectPath}/artisan`;
    const appKernelPath = `${projectPath}/app/Console/Kernel.php`;
    const indexPhpPath = `${projectPath}/system/core/CodeIgniter.php`;
    const cakePhpPath = `${projectPath}/config/bootstrap.php`;

    if (await fs.pathExists(artisanPath) || await fs.pathExists(appKernelPath)) {
      this.laravelFrameworkDetected = true;
    }

    if (await fs.pathExists(indexPhpPath)) {
      this.codeIgniterFrameworkDetected = true;
    }

    if (await fs.pathExists(cakePhpPath)) {
      const content = await fs.readFile(cakePhpPath, 'utf-8').catch(() => '');
      if (content.includes('CakePHP')) {
        this.cakePHPFrameworkDetected = true;
      }
    }

    const wordPressConfigPath = `${projectPath}/wp-config.php`;
    if (await fs.pathExists(wordPressConfigPath)) {
      this.wordPressFrameworkDetected = true;
    }
  }

  private async extractDependencies(projectPath: string, libraries: any[]): Promise<void> {
    const composerJsonPath = `${projectPath}/composer.json`;
    const composerLockPath = `${projectPath}/composer.lock`;

    if (await fs.pathExists(composerJsonPath)) {
      await this.extractComposerJsonDependencies(composerJsonPath, libraries);
    }

    if (await fs.pathExists(composerLockPath)) {
      await this.extractComposerLockDependencies(composerLockPath, libraries);
    }
  }

  private async extractComposerJsonDependencies(composerJsonPath: string, libraries: any[]): Promise<void> {
    try {
      const composerContent = await fs.readFile(composerJsonPath, 'utf-8');
      const composer = JSON.parse(composerContent);

      if (composer.require) {
        for (const [name, version] of Object.entries(composer.require)) {
          libraries.push({
            name,
            version: version as string,
            type: 'composer_package',
            source: 'composer.json',
            metadata: {
              isProduction: true,
              isDevelopment: false
            }
          });
        }
      }

      if (composer['require-dev']) {
        for (const [name, version] of Object.entries(composer['require-dev'])) {
          libraries.push({
            name,
            version: version as string,
            type: 'composer_package',
            source: 'composer.json',
            metadata: {
              isProduction: false,
              isDevelopment: true
            }
          });
        }
      }
    } catch (error) {
      console.warn('Failed to parse composer.json:', error);
    }
  }

  private async extractComposerLockDependencies(composerLockPath: string, libraries: any[]): Promise<void> {
    try {
      const composerLockContent = await fs.readFile(composerLockPath, 'utf-8');
      const composerLock = JSON.parse(composerLockContent);

      if (composerLock.packages) {
        for (const pkg of composerLock.packages) {
          const existingLib = libraries.find(lib => lib.name === pkg.name);
          if (existingLib) {
            existingLib.metadata.exactVersion = pkg.version;
            existingLib.metadata.source = pkg.source;
            existingLib.metadata.dist = pkg.dist;
          }
        }
      }

      if (composerLock['packages-dev']) {
        for (const pkg of composerLock['packages-dev']) {
          const existingLib = libraries.find(lib => lib.name === pkg.name);
          if (existingLib) {
            existingLib.metadata.exactVersion = pkg.version;
            existingLib.metadata.source = pkg.source;
            existingLib.metadata.dist = pkg.dist;
          }
        }
      }
    } catch (error) {
      console.warn('Failed to parse composer.lock:', error);
    }
  }

  private async analyzePHPFile(
    fullPath: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[],
    exitPoints: any[],
    namespaces: Map<string, string[]>,
    _context: AnalysisContext
  ): Promise<void> {
    try {
      const content = await this.readFileCached(fullPath);
      const lines = content.split('\n');

      const namespace = this.extractNamespace(content);
      const uses = this.extractUses(content);
      const classes = this.extractClasses(content, relativePath);
      const interfaces = this.extractInterfaces(content, relativePath);
      const traits = this.extractTraits(content, relativePath);
      const enums = this.extractEnums(content, relativePath);
      const functions = this.extractFunctions(content, relativePath);
      const globalVars = this.extractGlobalVariables(content);
      const constants = this.extractGlobalConstants(content);
      const degradation = detectSyntaxDegradation({
        relativePath,
        content,
        language: 'php',
        extractedNodeCount: classes.length + interfaces.length + traits.length + enums.length + functions.length,
      });
      if (degradation) this.addAnalysisWarning(degradation);

      if (namespace) {
        if (!namespaces.has(namespace)) {
          namespaces.set(namespace, []);
        }
        namespaces.get(namespace)!.push(relativePath);
      }

      const fileId = `file_${this.sanitizeId(relativePath)}`;
      const fileComments = this.extractCommentsFromFile(content, fullPath);
      const fileTodos = this.extractTodosFromComments(fileComments, fullPath);

      nodes.push(this.createNodeBuilder(
        fileId,
        relativePath.split('/').pop() || 'unknown.php',
        'file'
      )
        .withLevel(1, 'File/Module')
        .withCategory('modules', ['php-files'])
        .withSource({ file: fullPath, line: 1, end_line: lines.length })
        .withMetadata({
          attributes: {
            namespace: namespace || 'global',
            uses: uses.map(u => u.namespace),
            classCount: classes.length,
            interfaceCount: interfaces.length,
            traitCount: traits.length,
            enumCount: enums.length,
            functionCount: functions.length,
            globalVarCount: globalVars.length,
            constantCount: constants.length,
            extension: '.php',
            commentCount: fileComments.length,
            todoCount: fileTodos.length
          }
        })
        .withComments(fileComments.length > 0 ? fileComments : undefined)
        .withTodos(fileTodos.length > 0 ? fileTodos : undefined)
        .build());

      for (const use of uses) {
        const useId = `use_${fileId}_${this.sanitizeId(use.namespace)}`;
        nodes.push(this.createNodeBuilder(
          useId,
          use.alias || use.namespace,
          'use'
        )
          .withLevel(2, 'Import/Dependency')
          .withCategory('imports', ['php-uses'])
          .withSource({ file: fullPath, line: use.lineNumber })
          .withMetadata({
            attributes: {
              namespace: use.namespace,
              alias: use.alias,
              type: use.type,
              importType: this.isBuiltinNamespace(use.namespace) ? 'builtin' : 'external'
            }
          })
          .build());

        edges.push(this.createEdge(
          `${fileId}_uses_${useId}`,
          fileId,
          useId,
          'uses'
        ));

        if (!this.isBuiltinNamespace(use.namespace)) {
          exitPoints.push({
            id: `exit_${useId}`,
            name: `External namespace: ${use.namespace}`,
            type: 'external_namespace',
            source_node: useId,
            metadata: { namespace: use.namespace }
          });
        }
      }

      for (const cls of classes) {
        await this.processPHPClass(cls, fileId, fullPath, content, lines, fileComments, nodes, edges, entryPoints);
      }

      for (const intf of interfaces) {
        await this.processPHPInterface(intf, fileId, fullPath, fileComments, nodes, edges, entryPoints);
      }

      for (const trait of traits) {
        await this.processPHPTrait(trait, fileId, fullPath, content, lines, fileComments, nodes, edges, entryPoints);
      }

      for (const enm of enums) {
        await this.processPHPEnum(enm, fileId, fullPath, content, lines, fileComments, nodes, edges, entryPoints);
      }

      for (const func of functions) {
        await this.processPHPFunction(func, fileId, fullPath, lines, fileComments, nodes, edges, entryPoints);
      }

      this.detectSoapExitPoints(content, fullPath, fileId, classes, nodes, exitPoints);

      for (const variable of globalVars) {
        const variableId = `variable_${fileId}_${this.sanitizeId(variable.name)}`;
        nodes.push(this.createNodeBuilder(
          variableId,
          variable.name,
          'variable'
        )
          .withLevel(3, 'Variable/Property')
          .withCategory('data', ['php-variables'])
          .withSource({ file: fullPath, line: variable.lineNumber })
          .withMetadata({
            attributes: {
              type: variable.type,
              defaultValue: variable.defaultValue,
              scope: variable.scope,
              variableType: variable.type || 'mixed'
            }
          })
          .build());

        edges.push(this.createEdge(
          `${fileId}_contains_${variableId}`,
          fileId,
          variableId,
          'contains'
        ));
      }

      for (const constant of constants) {
        const constantId = `constant_${fileId}_${this.sanitizeId(constant.name)}`;
        const constantDocs = this.extractDocumentationFromPhpDoc(constant.docComment);

        nodes.push(this.createNodeBuilder(
          constantId,
          constant.name,
          'constant'
        )
          .withLevel(3, 'Constant/Property')
          .withCategory('data', ['php-constants'])
          .withSource({ file: fullPath, line: constant.lineNumber })
          .withMetadata({
            attributes: {
              value: constant.value,
              isClassConstant: constant.isClassConstant,
              hasDocumentation: !!constantDocs
            }
          })
          .withDocumentation(constantDocs)
          .build());

        edges.push(this.createEdge(
          `${fileId}_contains_${constantId}`,
          fileId,
          constantId,
          'contains'
        ));
      }

    } catch (error) {
      console.warn(`Failed to analyze PHP file ${relativePath}:`, error);
    }
  }

  private detectSoapExitPoints(
    content: string,
    fullPath: string,
    fileId: string,
    classes: PHPClass[],
    nodes: CASNode[],
    exitPoints: CASExitPoint[]
  ): void {
    if (!content.includes('SoapClient') && !content.includes('__soapCall')) return;

    const lines = content.split('\n');

    const soapClassNames = new Set<string>();
    let resolvedNewSoapClass = true;
    while (resolvedNewSoapClass) {
      resolvedNewSoapClass = false;
      for (const cls of classes) {
        if (soapClassNames.has(cls.name) || !cls.extendsClass) continue;
        const parentBase = cls.extendsClass.replace(/^\\+/, '').split('\\').pop() || '';
        if (parentBase === 'SoapClient' || soapClassNames.has(parentBase)) {
          soapClassNames.add(cls.name);
          resolvedNewSoapClass = true;
        }
      }
    }

    const isSoapClientClassName = (raw: string): boolean => {
      const base = raw.replace(/^\\+/, '').split('\\').pop() || '';
      return base === 'SoapClient' || soapClassNames.has(base);
    };

    const stringAssignments = new Map<string, string>();
    for (const line of lines) {
      const variableAssignment = line.match(/\$(\w+)\s*=\s*['"]([^'"]+)['"]\s*;/);
      if (variableAssignment) stringAssignments.set(variableAssignment[1], variableAssignment[2]);
      const constAssignment = line.match(/const\s+(\w+)\s*=\s*['"]([^'"]+)['"]/);
      if (constAssignment) stringAssignments.set(constAssignment[1], constAssignment[2]);
      const defineAssignment = line.match(/define\s*\(\s*['"](\w+)['"]\s*,\s*['"]([^'"]+)['"]/);
      if (defineAssignment) stringAssignments.set(defineAssignment[1], defineAssignment[2]);
    }

    const classWsdl = new Map<string, string>();
    for (const cls of classes) {
      if (!soapClassNames.has(cls.name)) continue;
      for (let i = cls.lineStart - 1; i < cls.lineEnd && i < lines.length; i++) {
        const wsdlLiteral = lines[i].match(/\$wsdl\s*=\s*[^;]*?['"]([^'"]+)['"]/) ||
          lines[i].match(/parent::__construct\s*\(\s*['"]([^'"]+)['"]/);
        if (wsdlLiteral && (/^https?:\/\//i.test(wsdlLiteral[1]) || /\.(wsdl|xml)(\?|$)/i.test(wsdlLiteral[1]) || /wsdl/i.test(wsdlLiteral[1]))) {
          classWsdl.set(cls.name, wsdlLiteral[1]);
          break;
        }
      }
    }

    const soapReceivers = new Map<string, { wsdl?: string; clientClass: string }>();

    for (const cls of classes) {
      for (const property of cls.properties) {
        const propertyType = (property.type || '').replace(/^\?/, '');
        if (propertyType && isSoapClientClassName(propertyType)) {
          const base = propertyType.replace(/^\\+/, '').split('\\').pop() || 'SoapClient';
          soapReceivers.set(`$this->${property.name}`, { wsdl: classWsdl.get(base), clientClass: base });
        }
      }
    }

    const resolveWsdlArgument = (argument: string): string | undefined => {
      const trimmed = argument.trim();
      const literal = trimmed.match(/^['"]([^'"]+)['"]$/);
      if (literal) return literal[1];
      const variable = trimmed.match(/^\$(\w+)$/);
      if (variable) return stringAssignments.get(variable[1]);
      const constant = trimmed.match(/^(?:self::|static::)?([A-Z][A-Z0-9_]*)$/);
      if (constant) return stringAssignments.get(constant[1]);
      return undefined;
    };

    const exitIds = new Set(exitPoints.map(exit => exit.id));
    const methodNodesInFile = nodes.filter(node =>
      (node.type === 'method' || node.type === 'function') && node.source?.file === fullPath
    );
    const enclosingNodeId = (lineNumber: number): string => {
      let innermost: CASNode | undefined;
      for (const node of methodNodesInFile) {
        if (node.source?.line === undefined || node.source?.end_line === undefined) continue;
        if (node.source.line > lineNumber || node.source.end_line < lineNumber) continue;
        if (!innermost || node.source.line > (innermost.source?.line ?? 0)) innermost = node;
      }
      return innermost?.id || fileId;
    };
    const enclosingSoapClass = (lineNumber: number): PHPClass | undefined =>
      classes.find(cls => soapClassNames.has(cls.name) && cls.lineStart <= lineNumber && cls.lineEnd >= lineNumber);

    const pushSoapExit = (
      lineNumber: number,
      operation: string | undefined,
      wsdl: string | undefined,
      clientClass: string
    ) => {
      const sourceNode = enclosingNodeId(lineNumber);
      const targetName = this.soapTargetName(wsdl, clientClass);
      const exitId = `exit_soap_${sourceNode}_${this.sanitizeId(operation || 'connect')}_${lineNumber}`;
      if (exitIds.has(exitId)) return;
      exitIds.add(exitId);
      exitPoints.push(this.createExitPoint(
        exitId,
        sourceNode,
        'api',
        operation ? `SOAP call: ${targetName}::${operation}` : `SOAP client: ${targetName}`,
        operation
          ? `SOAP operation ${operation} against ${targetName}`
          : `SOAP client construction for ${targetName}`,
        { endpoint: wsdl, resource: targetName, sdk: clientClass },
        { action: operation || 'connect', method: 'SOAP' },
        { protocol: 'soap', wsdl, line: lineNumber, client: clientClass }
      ));
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('new ')) continue;

      const constructions = line.matchAll(/(?:(\$this->\w+|\$\w+)\s*=\s*)?new\s+(\\?[\w\\]+)\s*\(\s*([^,)]*)/g);
      for (const construction of constructions) {
        const receiver = construction[1];
        const className = construction[2];
        if (!isSoapClientClassName(className)) continue;

        const classBase = className.replace(/^\\+/, '').split('\\').pop() || 'SoapClient';
        const wsdl = classBase === 'SoapClient'
          ? resolveWsdlArgument(construction[3] || '')
          : classWsdl.get(classBase) || resolveWsdlArgument(construction[3] || '');

        if (receiver) soapReceivers.set(receiver, { wsdl, clientClass: classBase });
        pushSoapExit(i + 1, undefined, wsdl, classBase);
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('->') && !line.includes('::')) continue;

      const soapCalls = line.matchAll(/(\$this->\w+|\$\w+|parent|self|static)(?:->|::)__soapCall\s*\(\s*['"]([\w.]+)['"]/g);
      for (const soapCall of soapCalls) {
        const receiver = soapCall[1];
        const operation = soapCall[2];

        if (receiver === '$this' || receiver === 'parent' || receiver === 'self' || receiver === 'static') {
          const soapClass = enclosingSoapClass(i + 1);
          if (!soapClass) continue;
          pushSoapExit(i + 1, operation, classWsdl.get(soapClass.name), soapClass.name);
        } else {
          const traced = soapReceivers.get(receiver);
          if (!traced) continue;
          pushSoapExit(i + 1, operation, traced.wsdl, traced.clientClass);
        }
      }

      const directCalls = line.matchAll(/(\$this->\w+|\$\w+)->(\w+)\s*\(/g);
      for (const directCall of directCalls) {
        const receiver = directCall[1];
        const methodName = directCall[2];
        if (methodName.startsWith('__')) continue;
        const traced = soapReceivers.get(receiver);
        if (!traced) continue;
        pushSoapExit(i + 1, methodName, traced.wsdl, traced.clientClass);
      }
    }
  }

  private soapTargetName(wsdl: string | undefined, clientClass: string): string {
    if (wsdl) {
      if (/^https?:\/\//i.test(wsdl)) {
        try {
          return new URL(wsdl).hostname;
        } catch {
          // fall through to other naming strategies
        }
      }
      const basename = wsdl.split('/').pop();
      if (basename && /\.(wsdl|xml)$/i.test(basename)) return basename;
    }
    return clientClass;
  }

  private async processPHPClass(
    cls: PHPClass,
    fileId: string,
    fullPath: string,
    _content: string,
    lines: string[],
    fileComments: CASComment[],
    nodes: CASNode[],
    edges: CASEdge[],
    _entryPoints: any[]
  ): Promise<void> {
    const classId = `class_${this.sanitizeId(cls.namespace)}_${this.sanitizeId(cls.name)}`;
    const classComments = fileComments.filter(c =>
      c.location.line >= cls.lineStart - 3 && c.location.line <= cls.lineStart
    );
    const classTodos = this.extractTodosFromComments(classComments, classId);
    const classDocs = this.extractDocumentationFromPhpDoc(cls.docComment);

    nodes.push(this.createNodeBuilder(
      classId,
      cls.name,
      'class'
    )
      .withLevel(2, 'Class/Interface')
      .withCategory('structures', ['php-classes'])
      .withSource({ file: fullPath, line: cls.lineStart, end_line: cls.lineEnd })
      .withMetadata({
        is_exported: cls.modifiers.includes('public'),
        attributes: {
          namespace: cls.namespace,
          modifiers: cls.modifiers,
          extendsClass: cls.extendsClass,
          implementsInterfaces: cls.implementsInterfaces,
          traits: cls.traits,
          propertyCount: cls.properties.length,
          methodCount: cls.methods.length,
          constantCount: cls.constants.length,
          isAbstract: cls.isAbstract,
          isFinal: cls.isFinal,
          hasDocumentation: !!classDocs
        }
      })
      .withDocumentation(classDocs)
      .withComments(classComments.length > 0 ? classComments : undefined)
      .withTodos(classTodos.length > 0 ? classTodos : undefined)
      .build());

    edges.push(this.createEdge(
      `${fileId}_contains_${classId}`,
      fileId,
      classId,
      'contains'
    ));

    for (const property of cls.properties) {
      const propertyId = `property_${classId}_${this.sanitizeId(property.name)}`;
      const propertyDocs = this.extractDocumentationFromPhpDoc(property.docComment);

      nodes.push(this.createNodeBuilder(
        propertyId,
        property.name,
        'property'
      )
        .withLevel(4, 'Property/Field')
        .withCategory('data', ['class-properties'])
        .withSource({ file: fullPath, line: property.lineNumber })
        .withMetadata({
          is_exported: property.visibility === 'public',
          attributes: {
            type: property.type,
            defaultValue: property.defaultValue,
            visibility: property.visibility,
            modifiers: property.modifiers,
            isStatic: property.isStatic,
            isReadonly: property.isReadonly,
            propertyType: property.type || 'mixed',
            hasDocumentation: !!propertyDocs
          }
        })
        .withParent(classId)
        .withDocumentation(propertyDocs)
        .build());

      edges.push(this.createEdge(
        `${classId}_has_property_${propertyId}`,
        classId,
        propertyId,
        'has_property'
      ));
    }

    for (const method of cls.methods) {
      const methodId = `method_${classId}_${this.sanitizeId(method.name)}_${method.lineStart}`;
      const methodDocs = this.extractDocumentationFromPhpDoc(method.docComment);
      const methodComments = fileComments.filter(c =>
        c.location.line >= method.lineStart && c.location.line <= method.lineEnd
      );
      const methodTodos = this.extractTodosFromComments(methodComments, methodId);
      const methodBody = lines.slice(method.lineStart - 1, method.lineEnd);
      const implementationStatus = this.detectImplementationStatus(method, methodBody);

      nodes.push(this.createNodeBuilder(
        methodId,
        method.name,
        'method'
      )
        .withLevel(4, 'Method/Function')
        .withCategory('methods', ['class-methods'])
        .withSource({ file: fullPath, line: method.lineStart, end_line: method.lineEnd })
        .withMetadata({
          is_exported: method.visibility === 'public',
          attributes: {
            visibility: method.visibility,
            modifiers: method.modifiers,
            isAbstract: method.isAbstract,
            isFinal: method.isFinal,
            isStatic: method.isStatic,
            isConstructor: method.isConstructor,
            isDestructor: method.isDestructor,
            hasDocumentation: !!methodDocs
          }
        })
        .withSignature({
          parameters: method.parameters,
          return_type: method.returnType
        })
        .withParent(classId)
        .withDocumentation(methodDocs)
        .withComments(methodComments.length > 0 ? methodComments : undefined)
        .withTodos(methodTodos.length > 0 ? methodTodos : undefined)
        .withImplementationStatus(implementationStatus)
        .build());

      edges.push(this.createEdge(
        `${classId}_has_method_${methodId}`,
        classId,
        methodId,
        'has_method'
      ));

    }

    for (const constant of cls.constants) {
      const constantId = `constant_${classId}_${this.sanitizeId(constant.name)}`;
      const constantDocs = this.extractDocumentationFromPhpDoc(constant.docComment);

      nodes.push(this.createNodeBuilder(
        constantId,
        constant.name,
        'class_constant'
      )
        .withLevel(4, 'Constant/Property')
        .withCategory('data', ['class-constants'])
        .withSource({ file: fullPath, line: constant.lineNumber })
        .withMetadata({
          is_exported: constant.visibility === 'public',
          attributes: {
            value: constant.value,
            visibility: constant.visibility,
            hasDocumentation: !!constantDocs
          }
        })
        .withParent(classId)
        .withDocumentation(constantDocs)
        .build());

      edges.push(this.createEdge(
        `${classId}_has_constant_${constantId}`,
        classId,
        constantId,
        'has_constant'
      ));
    }

  }

  private async processPHPInterface(
    intf: PHPInterface,
    fileId: string,
    fullPath: string,
    fileComments: CASComment[],
    nodes: CASNode[],
    edges: CASEdge[],
    _entryPoints: any[]
  ): Promise<void> {
    const interfaceId = `interface_${this.sanitizeId(intf.namespace)}_${this.sanitizeId(intf.name)}`;
    const interfaceComments = fileComments.filter(c =>
      c.location.line >= intf.lineStart - 3 && c.location.line <= intf.lineStart
    );
    const interfaceTodos = this.extractTodosFromComments(interfaceComments, interfaceId);
    const interfaceDocs = this.extractDocumentationFromPhpDoc(intf.docComment);

    nodes.push(this.createNodeBuilder(
      interfaceId,
      intf.name,
      'interface'
    )
      .withLevel(2, 'Interface/Contract')
      .withCategory('structures', ['php-interfaces'])
      .withSource({ file: fullPath, line: intf.lineStart, end_line: intf.lineEnd })
      .withMetadata({
        is_exported: true,
        attributes: {
          namespace: intf.namespace,
          extendsInterfaces: intf.extendsInterfaces,
          methodCount: intf.methods.length,
          constantCount: intf.constants.length,
          hasDocumentation: !!interfaceDocs
        }
      })
      .withDocumentation(interfaceDocs)
      .withComments(interfaceComments.length > 0 ? interfaceComments : undefined)
      .withTodos(interfaceTodos.length > 0 ? interfaceTodos : undefined)
      .build());

    edges.push(this.createEdge(
      `${fileId}_contains_${interfaceId}`,
      fileId,
      interfaceId,
      'contains'
    ));

    for (const method of intf.methods) {
      const methodId = `method_${interfaceId}_${this.sanitizeId(method.name)}_${method.lineStart}`;
      const methodDocs = this.extractDocumentationFromPhpDoc(method.docComment);

      nodes.push(this.createNodeBuilder(
        methodId,
        method.name,
        'interface_method'
      )
        .withLevel(4, 'Method/Function')
        .withCategory('methods', ['interface-methods'])
        .withSource({ file: fullPath, line: method.lineStart, end_line: method.lineEnd })
        .withMetadata({
          is_exported: true,
          attributes: {
            visibility: method.visibility,
            hasDocumentation: !!methodDocs
          }
        })
        .withSignature({
          parameters: method.parameters,
          return_type: method.returnType
        })
        .withParent(interfaceId)
        .withDocumentation(methodDocs)
        .build());

      edges.push(this.createEdge(
        `${interfaceId}_declares_${methodId}`,
        interfaceId,
        methodId,
        'declares'
      ));
    }

    for (const constant of intf.constants) {
      const constantId = `constant_${interfaceId}_${this.sanitizeId(constant.name)}`;
      const constantDocs = this.extractDocumentationFromPhpDoc(constant.docComment);

      nodes.push(this.createNodeBuilder(
        constantId,
        constant.name,
        'interface_constant'
      )
        .withLevel(4, 'Constant/Property')
        .withCategory('data', ['interface-constants'])
        .withSource({ file: fullPath, line: constant.lineNumber })
        .withMetadata({
          is_exported: true,
          attributes: {
            value: constant.value,
            hasDocumentation: !!constantDocs
          }
        })
        .withParent(interfaceId)
        .withDocumentation(constantDocs)
        .build());

      edges.push(this.createEdge(
        `${interfaceId}_has_constant_${constantId}`,
        interfaceId,
        constantId,
        'has_constant'
      ));
    }
  }

  private async processPHPTrait(
    trait: PHPTrait,
    fileId: string,
    fullPath: string,
    _content: string,
    lines: string[],
    fileComments: CASComment[],
    nodes: CASNode[],
    edges: CASEdge[],
    _entryPoints: any[]
  ): Promise<void> {
    const traitId = `trait_${this.sanitizeId(trait.namespace)}_${this.sanitizeId(trait.name)}`;
    const traitComments = fileComments.filter(c =>
      c.location.line >= trait.lineStart - 3 && c.location.line <= trait.lineStart
    );
    const traitTodos = this.extractTodosFromComments(traitComments, traitId);
    const traitDocs = this.extractDocumentationFromPhpDoc(trait.docComment);

    nodes.push(this.createNodeBuilder(
      traitId,
      trait.name,
      'trait'
    )
      .withLevel(2, 'Class/Trait')
      .withCategory('structures', ['php-traits'])
      .withSource({ file: fullPath, line: trait.lineStart, end_line: trait.lineEnd })
      .withMetadata({
        is_exported: true,
        attributes: {
          namespace: trait.namespace,
          usedTraits: trait.usedTraits,
          propertyCount: trait.properties.length,
          methodCount: trait.methods.length,
          hasDocumentation: !!traitDocs
        }
      })
      .withDocumentation(traitDocs)
      .withComments(traitComments.length > 0 ? traitComments : undefined)
      .withTodos(traitTodos.length > 0 ? traitTodos : undefined)
      .build());

    edges.push(this.createEdge(
      `${fileId}_contains_${traitId}`,
      fileId,
      traitId,
      'contains'
    ));

    for (const property of trait.properties) {
      const propertyId = `property_${traitId}_${this.sanitizeId(property.name)}`;
      const propertyDocs = this.extractDocumentationFromPhpDoc(property.docComment);

      nodes.push(this.createNodeBuilder(
        propertyId,
        property.name,
        'property'
      )
        .withLevel(4, 'Property/Field')
        .withCategory('data', ['trait-properties'])
        .withSource({ file: fullPath, line: property.lineNumber })
        .withMetadata({
          is_exported: property.visibility === 'public',
          attributes: {
            type: property.type,
            defaultValue: property.defaultValue,
            visibility: property.visibility,
            modifiers: property.modifiers,
            isStatic: property.isStatic,
            isReadonly: property.isReadonly,
            propertyType: property.type || 'mixed',
            hasDocumentation: !!propertyDocs
          }
        })
        .withParent(traitId)
        .withDocumentation(propertyDocs)
        .build());

      edges.push(this.createEdge(
        `${traitId}_has_property_${propertyId}`,
        traitId,
        propertyId,
        'has_property'
      ));
    }

    for (const method of trait.methods) {
      const methodId = `method_${traitId}_${this.sanitizeId(method.name)}_${method.lineStart}`;
      const methodDocs = this.extractDocumentationFromPhpDoc(method.docComment);
      const methodComments = fileComments.filter(c =>
        c.location.line >= method.lineStart && c.location.line <= method.lineEnd
      );
      const methodTodos = this.extractTodosFromComments(methodComments, methodId);
      const methodBody = lines.slice(method.lineStart - 1, method.lineEnd);
      const implementationStatus = this.detectImplementationStatus(method, methodBody);

      nodes.push(this.createNodeBuilder(
        methodId,
        method.name,
        'method'
      )
        .withLevel(4, 'Method/Function')
        .withCategory('methods', ['trait-methods'])
        .withSource({ file: fullPath, line: method.lineStart, end_line: method.lineEnd })
        .withMetadata({
          is_exported: method.visibility === 'public',
          attributes: {
            visibility: method.visibility,
            modifiers: method.modifiers,
            isAbstract: method.isAbstract,
            isFinal: method.isFinal,
            isStatic: method.isStatic,
            hasDocumentation: !!methodDocs
          }
        })
        .withSignature({
          parameters: method.parameters,
          return_type: method.returnType
        })
        .withParent(traitId)
        .withDocumentation(methodDocs)
        .withComments(methodComments.length > 0 ? methodComments : undefined)
        .withTodos(methodTodos.length > 0 ? methodTodos : undefined)
        .withImplementationStatus(implementationStatus)
        .build());

      edges.push(this.createEdge(
        `${traitId}_has_method_${methodId}`,
        traitId,
        methodId,
        'has_method'
      ));
    }
  }

  private async processPHPEnum(
    enm: PHPEnum,
    fileId: string,
    fullPath: string,
    _content: string,
    lines: string[],
    fileComments: CASComment[],
    nodes: CASNode[],
    edges: CASEdge[],
    _entryPoints: any[]
  ): Promise<void> {
    const enumId = `enum_${this.sanitizeId(enm.namespace)}_${this.sanitizeId(enm.name)}`;
    const enumComments = fileComments.filter(c =>
      c.location.line >= enm.lineStart - 3 && c.location.line <= enm.lineStart
    );
    const enumTodos = this.extractTodosFromComments(enumComments, enumId);
    const enumDocs = this.extractDocumentationFromPhpDoc(enm.docComment);

    nodes.push(this.createNodeBuilder(
      enumId,
      enm.name,
      'enum'
    )
      .withLevel(2, 'Class/Enum')
      .withCategory('structures', ['php-enums'])
      .withSource({ file: fullPath, line: enm.lineStart, end_line: enm.lineEnd })
      .withMetadata({
        attributes: {
          namespace: enm.namespace,
          backingType: enm.backingType,
          implementsInterfaces: enm.implementsInterfaces,
          traits: enm.traits,
          caseCount: enm.cases.length,
          methodCount: enm.methods.length,
          constantCount: enm.constants.length,
          hasDocumentation: !!enumDocs
        }
      })
      .withDocumentation(enumDocs)
      .withComments(enumComments.length > 0 ? enumComments : undefined)
      .withTodos(enumTodos.length > 0 ? enumTodos : undefined)
      .build());

    edges.push(this.createEdge(
      `${fileId}_contains_${enumId}`,
      fileId,
      enumId,
      'contains'
    ));

    for (const enumCase of enm.cases) {
      const caseId = `case_${enumId}_${this.sanitizeId(enumCase.name)}`;
      const caseDocs = this.extractDocumentationFromPhpDoc(enumCase.docComment);

      nodes.push(this.createNodeBuilder(
        caseId,
        enumCase.name,
        'enum_case'
      )
        .withLevel(4, 'Constant/Property')
        .withCategory('data', ['enum-cases'])
        .withSource({ file: fullPath, line: enumCase.lineNumber })
        .withMetadata({
          attributes: {
            value: enumCase.value,
            hasDocumentation: !!caseDocs
          }
        })
        .withParent(enumId)
        .withDocumentation(caseDocs)
        .build());

      edges.push(this.createEdge(
        `${enumId}_has_case_${caseId}`,
        enumId,
        caseId,
        'has_case'
      ));
    }

    for (const method of enm.methods) {
      const methodId = `method_${enumId}_${this.sanitizeId(method.name)}_${method.lineStart}`;
      const methodDocs = this.extractDocumentationFromPhpDoc(method.docComment);
      const methodComments = fileComments.filter(c =>
        c.location.line >= method.lineStart && c.location.line <= method.lineEnd
      );
      const methodTodos = this.extractTodosFromComments(methodComments, methodId);
      const methodBody = lines.slice(method.lineStart - 1, method.lineEnd);
      const implementationStatus = this.detectImplementationStatus(method, methodBody);

      nodes.push(this.createNodeBuilder(
        methodId,
        method.name,
        'method'
      )
        .withLevel(4, 'Method/Function')
        .withCategory('methods', ['enum-methods'])
        .withSource({ file: fullPath, line: method.lineStart, end_line: method.lineEnd })
        .withMetadata({
          is_exported: method.visibility === 'public',
          attributes: {
            visibility: method.visibility,
            modifiers: method.modifiers,
            isStatic: method.isStatic,
            hasDocumentation: !!methodDocs
          }
        })
        .withSignature({
          parameters: method.parameters,
          return_type: method.returnType
        })
        .withParent(enumId)
        .withDocumentation(methodDocs)
        .withComments(methodComments.length > 0 ? methodComments : undefined)
        .withTodos(methodTodos.length > 0 ? methodTodos : undefined)
        .withImplementationStatus(implementationStatus)
        .build());

      edges.push(this.createEdge(
        `${enumId}_has_method_${methodId}`,
        enumId,
        methodId,
        'has_method'
      ));
    }
  }

  private async processPHPFunction(
    func: PHPFunction,
    fileId: string,
    fullPath: string,
    lines: string[],
    fileComments: CASComment[],
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const functionId = `function_${this.sanitizeId(func.namespace)}_${this.sanitizeId(func.name)}_${func.lineStart}`;
    const funcDocs = this.extractDocumentationFromPhpDoc(func.docComment);
    const funcComments = fileComments.filter(c =>
      c.location.line >= func.lineStart && c.location.line <= func.lineEnd
    );
    const funcTodos = this.extractTodosFromComments(funcComments, functionId);
    const funcBody = lines.slice(func.lineStart - 1, func.lineEnd);
    const implementationStatus = this.detectImplementationStatus({ name: func.name, isAbstract: false } as any, funcBody);

    nodes.push(this.createNodeBuilder(
      functionId,
      func.name,
      'function'
    )
      .withLevel(3, 'Function')
      .withCategory('functions', ['php-functions'])
      .withSource({ file: fullPath, line: func.lineStart, end_line: func.lineEnd })
      .withMetadata({
        attributes: {
          namespace: func.namespace,
          hasDocumentation: !!funcDocs
        }
      })
      .withSignature({
        parameters: func.parameters,
        return_type: func.returnType
      })
      .withDocumentation(funcDocs)
      .withComments(funcComments.length > 0 ? funcComments : undefined)
      .withTodos(funcTodos.length > 0 ? funcTodos : undefined)
      .withImplementationStatus(implementationStatus)
      .build());

    edges.push(this.createEdge(
      `${fileId}_contains_${functionId}`,
      fileId,
      functionId,
      'contains'
    ));

    entryPoints.push({
      id: `entry_${functionId}`,
      name: `Function: ${func.name}`,
      type: 'function',
      source_node: functionId,
      metadata: {
        namespace: func.namespace,
        functionName: func.name,
        returnType: func.returnType,
        parameters: func.parameters.map(p => p.type)
      }
    });
  }

  private extractNamespace(content: string): string | null {
    const namespaceMatch = content.match(/namespace\s+([a-zA-Z0-9_\\]+)\s*[;{]/);
    return namespaceMatch ? namespaceMatch[1] : null;
  }

  private extractUses(content: string): PHPUse[] {
    const uses: PHPUse[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      const useMatch = line.match(/use\s+(function\s+|const\s+)?([a-zA-Z0-9_\\]+)(?:\s+as\s+([a-zA-Z0-9_]+))?\s*;/);
      if (useMatch) {
        const typePrefix = useMatch[1]?.trim();
        const namespace = useMatch[2];
        const alias = useMatch[3];

        let type: 'class' | 'function' | 'const' = 'class';
        if (typePrefix === 'function') type = 'function';
        else if (typePrefix === 'const') type = 'const';

        uses.push({
          namespace,
          alias,
          type,
          lineNumber: i + 1
        });
      }
    }

    return uses;
  }

  private extractClasses(content: string, filePath: string): PHPClass[] {
    const classes: PHPClass[] = [];
    const lines = content.split('\n');
    const namespace = this.extractNamespace(content) || '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('class ') && !line.startsWith('//') && !line.startsWith('*')) {
        const classMatch = line.match(/(abstract\s+|final\s+)?class\s+([a-zA-Z0-9_]+)(?:\s+extends\s+([a-zA-Z0-9_\\]+))?(?:\s+implements\s+([a-zA-Z0-9_\\,\s]+))?/);
        if (classMatch) {
          const modifierStr = classMatch[1] || '';
          const className = classMatch[2];
          const extendsClass = classMatch[3];
          const implementsStr = classMatch[4];

          const modifiers = modifierStr.trim().split(/\s+/).filter(m => m);
          const implementsInterfaces = implementsStr ? implementsStr.split(',').map(i => i.trim()) : [];

          const docComment = this.extractDocComment(lines, i);
          const classStartLine = i + 1;
          const classEndLine = this.findBlockEnd(lines, i);

          const properties = this.extractProperties(lines, i, classEndLine);
          const methods = this.extractMethods(lines, i, classEndLine);
          const constants = this.extractClassConstants(lines, i, classEndLine);
          const traits = this.extractUsedTraits(lines, i, classEndLine);

          classes.push({
            name: className,
            namespace,
            filePath,
            modifiers,
            extendsClass,
            implementsInterfaces,
            properties,
            methods,
            constants,
            traits,
            docComment,
            lineStart: classStartLine,
            lineEnd: classEndLine,
            isAbstract: modifiers.includes('abstract'),
            isFinal: modifiers.includes('final')
          });
        }
      }
    }

    return classes;
  }

  private extractInterfaces(content: string, filePath: string): PHPInterface[] {
    const interfaces: PHPInterface[] = [];
    const lines = content.split('\n');
    const namespace = this.extractNamespace(content) || '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('interface ') && !line.startsWith('//') && !line.startsWith('*')) {
        const interfaceMatch = line.match(/interface\s+([a-zA-Z0-9_]+)(?:\s+extends\s+([a-zA-Z0-9_\\,\s]+))?/);
        if (interfaceMatch) {
          const interfaceName = interfaceMatch[1];
          const extendsStr = interfaceMatch[2];

          const extendsInterfaces = extendsStr ? extendsStr.split(',').map(i => i.trim()) : [];

          const docComment = this.extractDocComment(lines, i);
          const interfaceStartLine = i + 1;
          const interfaceEndLine = this.findBlockEnd(lines, i);

          const methods = this.extractMethods(lines, i, interfaceEndLine);
          const constants = this.extractClassConstants(lines, i, interfaceEndLine);

          interfaces.push({
            name: interfaceName,
            namespace,
            filePath,
            extendsInterfaces,
            methods,
            constants,
            docComment,
            lineStart: interfaceStartLine,
            lineEnd: interfaceEndLine
          });
        }
      }
    }

    return interfaces;
  }

  private extractTraits(content: string, filePath: string): PHPTrait[] {
    const traits: PHPTrait[] = [];
    const lines = content.split('\n');
    const namespace = this.extractNamespace(content) || '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('trait ') && !line.startsWith('//') && !line.startsWith('*')) {
        const traitMatch = line.match(/trait\s+([a-zA-Z0-9_]+)/);
        if (traitMatch) {
          const traitName = traitMatch[1];

          const docComment = this.extractDocComment(lines, i);
          const traitStartLine = i + 1;
          const traitEndLine = this.findBlockEnd(lines, i);

          const properties = this.extractProperties(lines, i, traitEndLine);
          const methods = this.extractMethods(lines, i, traitEndLine);
          const usedTraits = this.extractUsedTraits(lines, i, traitEndLine);

          traits.push({
            name: traitName,
            namespace,
            filePath,
            properties,
            methods,
            usedTraits,
            docComment,
            lineStart: traitStartLine,
            lineEnd: traitEndLine
          });
        }
      }
    }

    return traits;
  }

  private extractEnums(content: string, filePath: string): PHPEnum[] {
    const enums: PHPEnum[] = [];
    const lines = content.split('\n');
    const namespace = this.extractNamespace(content) || '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('enum ') && !line.startsWith('//') && !line.startsWith('*')) {
        const enumMatch = line.match(/enum\s+([a-zA-Z0-9_]+)(?:\s*:\s*([a-zA-Z0-9_]+))?(?:\s+implements\s+([a-zA-Z0-9_\\,\s]+))?/);
        if (enumMatch) {
          const enumName = enumMatch[1];
          const backingType = enumMatch[2];
          const implementsStr = enumMatch[3];

          const implementsInterfaces = implementsStr ? implementsStr.split(',').map(i => i.trim()) : [];

          const docComment = this.extractDocComment(lines, i);
          const enumStartLine = i + 1;
          const enumEndLine = this.findBlockEnd(lines, i);

          const cases = this.extractEnumCases(lines, i, enumEndLine);
          const methods = this.extractMethods(lines, i, enumEndLine);
          const constants = this.extractClassConstants(lines, i, enumEndLine);
          const traits = this.extractUsedTraits(lines, i, enumEndLine);

          enums.push({
            name: enumName,
            namespace,
            filePath,
            backingType,
            cases,
            methods,
            constants,
            implementsInterfaces,
            traits,
            docComment,
            lineStart: enumStartLine,
            lineEnd: enumEndLine
          });
        }
      }
    }

    return enums;
  }

  private extractFunctions(content: string, filePath: string): PHPFunction[] {
    const functions: PHPFunction[] = [];
    const lines = content.split('\n');
    const namespace = this.extractNamespace(content) || '';
    const typeBlockRanges = this.extractTypeBlockRanges(lines);
    let rangeIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      while (rangeIndex < typeBlockRanges.length && i > typeBlockRanges[rangeIndex].end) {
        rangeIndex++;
      }
      const insideTypeBlock = rangeIndex < typeBlockRanges.length &&
        i >= typeBlockRanges[rangeIndex].start &&
        i <= typeBlockRanges[rangeIndex].end;

      if (line.includes('function ') && !line.startsWith('//') && !line.startsWith('*') && !insideTypeBlock) {
        const functionMatch = line.match(/function\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?/);
        if (functionMatch) {
          const functionName = functionMatch[1];
          const paramsStr = functionMatch[2];
          const returnType = functionMatch[3]?.trim();

          const docComment = this.extractDocComment(lines, i);
          const functionStartLine = i + 1;
          const functionEndLine = this.findBlockEnd(lines, i);

          const parameters = this.extractFunctionParameters(paramsStr);

          functions.push({
            name: functionName,
            namespace,
            filePath,
            parameters,
            returnType,
            docComment,
            lineStart: functionStartLine,
            lineEnd: functionEndLine
          });
        }
      }
    }

    return functions;
  }

  private extractTypeBlockRanges(lines: string[]): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];
    const declarationPattern = /\b(?:class|interface|trait|enum)\s+[A-Za-z_][A-Za-z0-9_]*/;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('//') || line.startsWith('*') || !declarationPattern.test(line)) continue;
      ranges.push({ start: i, end: this.findBlockEnd(lines, i) - 1 });
    }
    return ranges.sort((left, right) => left.start - right.start);
  }

  private extractProperties(lines: string[], classStart: number, classEnd: number): PHPProperty[] {
    const properties: PHPProperty[] = [];

    for (let i = classStart + 1; i < classEnd; i++) {
      const line = lines[i].trim();

      if (this.isPropertyDeclaration(line)) {
        const propertyMatch = line.match(/(public|private|protected)(?:\s+(static|readonly))?\s+(?:([a-zA-Z0-9_\\|?]+)\s+)?\$([a-zA-Z0-9_]+)(?:\s*=\s*([^;]+))?/);
        if (propertyMatch) {
          const visibility = propertyMatch[1];
          const modifier = propertyMatch[2];
          const type = propertyMatch[3];
          const propertyName = propertyMatch[4];
          const defaultValue = propertyMatch[5]?.trim();

          const modifiers = [visibility];
          if (modifier) modifiers.push(modifier);

          const docComment = this.extractDocComment(lines, i);

          properties.push({
            name: propertyName,
            visibility,
            modifiers,
            type,
            defaultValue,
            docComment,
            lineNumber: i + 1,
            isStatic: modifier === 'static',
            isReadonly: modifier === 'readonly'
          });
        }
      }
    }

    return properties;
  }

  private extractMethods(lines: string[], classStart: number, classEnd: number): PHPMethod[] {
    const methods: PHPMethod[] = [];

    for (let i = classStart + 1; i < classEnd; i++) {
      const line = lines[i].trim();

      if (this.isMethodDeclaration(line)) {
        // Modern PHP (Symfony especially) writes signatures across MANY lines
        // — one param per line, attributes interleaved. Join the declaration
        // until its parens balance so those methods exist as nodes at all
        // (a missing controller/service method kills the whole call chain).
        let signatureText = line;
        let signatureEndIndex = i;
        {
          let depth = 0;
          for (const ch of line) {
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
          }
          for (let j = i + 1; depth > 0 && j < Math.min(lines.length, i + 60); j++) {
            const cont = lines[j].trim();
            signatureText += ' ' + cont;
            for (const ch of cont) {
              if (ch === '(') depth++;
              else if (ch === ')') depth--;
            }
            signatureEndIndex = j;
          }
        }
        // Visibility is OPTIONAL in PHP — a bare `function name()` inside a class
        // is implicitly public. Capture any leading modifiers as a prefix and
        // parse them (order-independent: `public static` or `static public`),
        // defaulting visibility to public when none is written.
        const methodMatch = signatureText.match(/^((?:(?:public|private|protected|static|abstract|final|readonly)\s+)*)function\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)(?:\s*:\s*([^{;]+))?/);
        if (methodMatch) {
          const mods = methodMatch[1].trim().split(/\s+/).filter(Boolean);
          const visibility = mods.find(m => m === 'public' || m === 'private' || m === 'protected') || 'public';
          const modifier = mods.find(m => m === 'static' || m === 'abstract' || m === 'final');
          const methodName = methodMatch[2];
          const paramsStr = methodMatch[3];
          const returnType = methodMatch[4]?.trim();

          const modifiers: string[] = [visibility];
          if (modifier) modifiers.push(modifier);

          const docComment = this.extractDocComment(lines, i);
          // Abstract/interface signatures end in `;` with no body — for the
          // multi-line form the end is where the signature closed, not the
          // next block findBlockEnd would swallow.
          const methodEndLine = signatureEndIndex > i && signatureText.trimEnd().endsWith(';')
            ? signatureEndIndex + 1
            : this.findMethodEnd(lines, signatureEndIndex > i ? signatureEndIndex : i);

          const parameters = this.extractFunctionParameters(paramsStr);

          methods.push({
            name: methodName,
            visibility,
            modifiers,
            parameters,
            returnType,
            docComment,
            lineStart: i + 1,
            lineEnd: methodEndLine,
            isAbstract: modifier === 'abstract',
            isFinal: modifier === 'final',
            isStatic: modifier === 'static',
            isConstructor: methodName === '__construct',
            isDestructor: methodName === '__destruct'
          });
        }
      }
    }

    return methods;
  }

  private extractClassConstants(lines: string[], classStart: number, classEnd: number): PHPConstant[] {
    const constants: PHPConstant[] = [];

    for (let i = classStart + 1; i < classEnd; i++) {
      const line = lines[i].trim();

      if (this.isConstantDeclaration(line)) {
        const constantMatch = line.match(/(public|private|protected)?\s*const\s+([a-zA-Z0-9_]+)\s*=\s*([^;]+);/);
        if (constantMatch) {
          const visibility = constantMatch[1] || 'public';
          const constantName = constantMatch[2];
          const value = constantMatch[3].trim();

          const docComment = this.extractDocComment(lines, i);

          constants.push({
            name: constantName,
            value,
            visibility,
            docComment,
            lineNumber: i + 1,
            isClassConstant: true
          });
        }
      }
    }

    return constants;
  }

  private extractEnumCases(lines: string[], enumStart: number, enumEnd: number): PHPEnumCase[] {
    const cases: PHPEnumCase[] = [];

    for (let i = enumStart + 1; i < enumEnd; i++) {
      const line = lines[i].trim();

      if (line.startsWith('case ')) {
        const caseMatch = line.match(/case\s+([a-zA-Z0-9_]+)(?:\s*=\s*([^;]+))?;/);
        if (caseMatch) {
          const caseName = caseMatch[1];
          const value = caseMatch[2]?.trim();

          const docComment = this.extractDocComment(lines, i);

          cases.push({
            name: caseName,
            value,
            docComment,
            lineNumber: i + 1
          });
        }
      }
    }

    return cases;
  }

  private extractUsedTraits(lines: string[], classStart: number, classEnd: number): string[] {
    const traits: string[] = [];

    for (let i = classStart + 1; i < classEnd; i++) {
      const line = lines[i].trim();

      if (line.startsWith('use ') && !line.includes('function') && !line.includes('const')) {
        const traitMatch = line.match(/use\s+([a-zA-Z0-9_\\,\s]+);/);
        if (traitMatch) {
          const traitNames = traitMatch[1].split(',').map(t => t.trim());
          traits.push(...traitNames);
        }
      }
    }

    return traits;
  }

  private extractGlobalVariables(content: string): PHPVariable[] {
    const variables: PHPVariable[] = [];
    const lines = content.split('\n');
    const blockedRanges = this.extractNonGlobalBlockRanges(lines);
    let rangeIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      while (rangeIndex < blockedRanges.length && i > blockedRanges[rangeIndex].end) {
        rangeIndex++;
      }
      if (rangeIndex < blockedRanges.length && i >= blockedRanges[rangeIndex].start && i <= blockedRanges[rangeIndex].end) {
        continue;
      }

      if (this.isGlobalVariableDeclaration(line)) {
        const varMatch = line.match(/\$([a-zA-Z0-9_]+)(?:\s*=\s*([^;]+))?;/);
        if (varMatch) {
          const varName = varMatch[1];
          const defaultValue = varMatch[2]?.trim();

          variables.push({
            name: varName,
            scope: 'global',
            defaultValue,
            lineNumber: i + 1
          });
        }
      }
    }

    return variables;
  }

  private extractGlobalConstants(content: string): PHPConstant[] {
    const constants: PHPConstant[] = [];
    const lines = content.split('\n');
    const blockedRanges = this.extractNonGlobalBlockRanges(lines);
    let rangeIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      while (rangeIndex < blockedRanges.length && i > blockedRanges[rangeIndex].end) {
        rangeIndex++;
      }
      if (rangeIndex < blockedRanges.length && i >= blockedRanges[rangeIndex].start && i <= blockedRanges[rangeIndex].end) {
        continue;
      }

      if (line.startsWith('define(') || line.startsWith('const ')) {
        let constantMatch: RegExpMatchArray | null = null;

        if (line.startsWith('define(')) {
          constantMatch = line.match(/define\s*\(\s*['"']([^'"']+)['"']\s*,\s*([^)]+)\)/);
          if (constantMatch) {
            constants.push({
              name: constantMatch[1],
              value: constantMatch[2].trim(),
              lineNumber: i + 1,
              isClassConstant: false
            });
          }
        } else {
          constantMatch = line.match(/const\s+([a-zA-Z0-9_]+)\s*=\s*([^;]+);/);
          if (constantMatch) {
            constants.push({
              name: constantMatch[1],
              value: constantMatch[2].trim(),
              lineNumber: i + 1,
              isClassConstant: false
            });
          }
        }
      }
    }

    return constants;
  }

  private extractNonGlobalBlockRanges(lines: string[]): Array<{ start: number; end: number }> {
    const ranges = this.extractTypeBlockRanges(lines);
    const functionPattern = /\bfunction\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('//') || line.startsWith('*') || !functionPattern.test(line)) continue;
      ranges.push({ start: i, end: this.findBlockEnd(lines, i) - 1 });
    }
    return ranges.sort((left, right) => left.start - right.start);
  }

  private extractFunctionParameters(paramsStr: string): PHPParameter[] {
    const parameters: PHPParameter[] = [];

    if (!paramsStr.trim()) {
      return parameters;
    }

    const params = this.splitParameters(paramsStr);

    for (const param of params) {
      const trimmed = param.trim();

      const paramMatch = trimmed.match(/^(?:([a-zA-Z0-9_\\|?]+)\s+)?(&)?(\.\.\.)?\$([a-zA-Z0-9_]+)(?:\s*=\s*(.+))?$/);
      if (paramMatch) {
        const type = paramMatch[1];
        const isReference = !!paramMatch[2];
        const isVariadic = !!paramMatch[3];
        const paramName = paramMatch[4];
        const defaultValue = paramMatch[5]?.trim();

        parameters.push({
          name: paramName,
          type,
          defaultValue,
          isVariadic,
          isReference,
          isNullable: type?.includes('?') || false
        });
      }
    }

    return parameters;
  }

  private extractDocComment(lines: string[], lineIndex: number): string | undefined {
    let docComment = '';
    let foundDocComment = false;

    for (let i = lineIndex - 1; i >= 0; i--) {
      const line = lines[i].trim();

      if (line === '*/') {
        foundDocComment = true;
        continue;
      }

      if (foundDocComment) {
        if (line.startsWith('/**')) {
          docComment = lines.slice(i, lineIndex).join('\n').trim();
          break;
        }
        if (!line.startsWith('*')) {
          break;
        }
      } else if (line && !line.startsWith('//')) {
        break;
      }
    }

    return foundDocComment ? docComment : undefined;
  }

  private splitParameters(paramsStr: string): string[] {
    const params: string[] = [];
    let current = '';
    let depth = 0;

    for (const char of paramsStr) {
      if (char === '(') depth++;
      else if (char === ')') depth--;
      else if (char === ',' && depth === 0) {
        params.push(current.trim());
        current = '';
        continue;
      }

      current += char;
    }

    if (current.trim()) {
      params.push(current.trim());
    }

    return params;
  }

  private isPropertyDeclaration(line: string): boolean {
    return line.includes('$') &&
           (line.includes('public') || line.includes('private') || line.includes('protected')) &&
           !line.includes('function') &&
           !line.includes('return') &&
           !line.includes('=');
  }


  private isConstantDeclaration(line: string): boolean {
    return line.includes('const ') &&
           !line.startsWith('//') &&
           line.includes('=');
  }

  private isGlobalVariableDeclaration(line: string): boolean {
    return line.startsWith('$') &&
           !line.includes('function') &&
           !line.includes('class') &&
           !line.includes('interface') &&
           !line.includes('trait');
  }

  private isInsideClass(lines: string[], lineIndex: number): boolean {
    let braceCount = 0;

    for (let i = lineIndex - 1; i >= 0; i--) {
      const line = lines[i];

      for (const char of line) {
        if (char === '}') {
          braceCount++;
        } else if (char === '{') {
          braceCount--;
          if (braceCount < 0) {
            const lineStr = lines[i].trim();
            return lineStr.includes('class ') || lineStr.includes('interface ') || lineStr.includes('trait ');
          }
        }
      }
    }

    return false;
  }

  private findBlockEnd(lines: string[], startIndex: number): number {
    let braceCount = 0;
    let foundOpenBrace = false;

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];

      for (const char of line) {
        if (char === '{') {
          braceCount++;
          foundOpenBrace = true;
        } else if (char === '}') {
          braceCount--;
          if (foundOpenBrace && braceCount === 0) {
            return i + 1;
          }
        }
      }
    }

    return lines.length;
  }

  private findMethodEnd(lines: string[], startIndex: number): number {
    const line = lines[startIndex];

    if (line.includes(';')) {
      return startIndex + 1;
    }

    return this.findBlockEnd(lines, startIndex);
  }

  private buildNamespaceHierarchy(namespaces: Map<string, string[]>, nodes: CASNode[], edges: CASEdge[]): void {
    for (const [namespaceName, files] of namespaces.entries()) {
      const namespaceId = `namespace_${this.sanitizeId(namespaceName)}`;

      nodes.push(this.createNodeBuilder(
        namespaceId,
        namespaceName,
        'namespace'
      )
        .withLevel(1, 'Namespace')
        .withCategory('structure', ['php-namespaces'])
        .withMetadata({
          attributes: {
            fileCount: files.length,
            files: files
          }
        })
        .build());

      for (const file of files) {
        const fileId = `file_${this.sanitizeId(file)}`;
        edges.push(this.createEdge(
          `${namespaceId}_contains_${fileId}`,
          namespaceId,
          fileId,
          'contains'
        ));
      }
    }
  }

  private detectFrameworkPatterns(nodes: CASNode[], _edges: CASEdge[], entryPoints: any[]): void {
    const seenEntryPoints = new Set(entryPoints.map(entry => entry.id));
    const frameworkPatterns = {
      laravel: ['Controller', 'Model', 'Illuminate\\', 'Route::', 'Artisan'],
      symfony: ['Symfony\\', 'Controller', 'Bundle', 'DependencyInjection'],
      codeigniter: ['CI_Controller', 'CI_Model', 'CodeIgniter\\'],
      cakephp: ['CakeObject', 'AppController', 'CakePHP\\'],
      drupal: ['Drupal\\', 'DrupalKernel', 'ModuleHandlerInterface'],
      wordpress: ['wp_', 'WP_', 'add_action', 'add_filter', 'get_option']
    };

    for (const node of nodes) {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'class' || node.type === 'function') {
        const nodeName = node.name;
        const namespace = node.metadata?.attributes?.namespace as string;
        const isLikelyEntrySurface =
          /(?:Controller|Command|Kernel|Subscriber|Listener|Handler|Middleware|Action)$/i.test(nodeName) ||
          nodeName === 'Kernel' ||
          (node.type === 'function' && (!namespace || namespace === 'global'));

        if (!isLikelyEntrySurface) {
          continue;
        }

        for (const [framework, patterns] of Object.entries(frameworkPatterns)) {
          if (patterns.some(pattern =>
            nodeName.includes(pattern) ||
            namespace?.includes(pattern) ||
            (node.metadata?.attributes?.extendsClass as string)?.includes(pattern) ||
            (node.metadata?.attributes?.implementsInterfaces as string[])?.some(i => i.includes(pattern))
          )) {
            const entryId = `entry_${framework}_${node.id}`;
            if (seenEntryPoints.has(entryId)) continue;
            seenEntryPoints.add(entryId);
            entryPoints.push({
              id: entryId,
              name: `${framework.charAt(0).toUpperCase() + framework.slice(1)} component: ${node.name}`,
              type: `${framework}_component`,
              source_node: node.id,
              metadata: {
                framework,
                componentName: node.name
              }
            });
          }
        }
      }
    }
  }

  private buildInheritanceRelationships(nodes: CASNode[], edges: CASEdge[]): void {
    const classNodes = nodes.filter(n => n.type === 'class');
    const interfaceNodes = nodes.filter(n => n.type === 'interface');

    for (const classNode of classNodes) {
      if (classNode.metadata?.attributes?.extendsClass) {
        const parentClassName = classNode.metadata.attributes?.extendsClass as string;
        const parentClassNode = classNodes.find(n => n.name === parentClassName);

        if (parentClassNode) {
          edges.push(this.createEdge(
            `${classNode.id}_extends_${parentClassNode.id}`,
            classNode.id,
            parentClassNode.id,
            'extends'
          ));
        }
      }

      if (classNode.metadata?.attributes?.implementsInterfaces) {
        const implementedInterfaces = classNode.metadata.attributes?.implementsInterfaces as string[];
        for (const interfaceName of implementedInterfaces) {
          const interfaceNode = interfaceNodes.find(n => n.name === interfaceName);

          if (interfaceNode) {
            edges.push(this.createEdge(
              `${classNode.id}_implements_${interfaceNode.id}`,
              classNode.id,
              interfaceNode.id,
              'implements'
            ));
          }
        }
      }

      if (classNode.metadata?.attributes?.traits) {
        const usedTraits = classNode.metadata.attributes?.traits as string[];
        for (const traitName of usedTraits) {
          const traitNode = nodes.find(n => n.type === 'trait' && n.name === traitName);

          if (traitNode) {
            edges.push(this.createEdge(
              `${classNode.id}_uses_${traitNode.id}`,
              classNode.id,
              traitNode.id,
              'uses_trait'
            ));
          }
        }
      }
    }

    for (const interfaceNode of interfaceNodes) {
      if (interfaceNode.metadata?.attributes?.extendsInterfaces) {
        const extendedInterfaces = interfaceNode.metadata.attributes?.extendsInterfaces as string[];
        for (const parentInterfaceName of extendedInterfaces) {
          const parentInterfaceNode = interfaceNodes.find(n => n.name === parentInterfaceName);

          if (parentInterfaceNode) {
            edges.push(this.createEdge(
              `${interfaceNode.id}_extends_${parentInterfaceNode.id}`,
              interfaceNode.id,
              parentInterfaceNode.id,
              'extends'
            ));
          }
        }
      }
    }
  }

  private isBuiltinNamespace(namespace: string): boolean {
    const builtinNamespaces = [
      'stdClass', 'Exception', 'ErrorException', 'Error', 'ParseError', 'TypeError',
      'ArgumentCountError', 'ArithmeticError', 'AssertionError', 'DivisionByZeroError',
      'CompileError', 'FatalError', 'Closure', 'Generator', 'WeakReference',
      'DateTime', 'DateTimeImmutable', 'DateTimeZone', 'DateInterval', 'DatePeriod',
      'ReflectionClass', 'ReflectionMethod', 'ReflectionProperty', 'ReflectionFunction',
      'PDO', 'PDOStatement', 'PDOException', 'mysqli', 'SplFileObject'
    ];

    return builtinNamespaces.some(builtin => namespace === builtin || namespace.startsWith(builtin));
  }

  /**
   * Map each in-scope variable to its declared class within a method's line
   * range, so a `$recv->method()` call resolves to $recv's class only (not the
   * containing class, and not every same-name method). Sources: typed params
   * (`Account $a`) and `$x = new Type()`.
   */
  private buildPhpReceiverTypes(lines: string[], startLine: number, endLine: number): Map<string, string> {
    const m = new Map<string, string>();
    const baseType = (t: string) => t.replace(/^[?\\]+/, '').split('\\').pop()!.trim();
    const lo = Math.max(0, startLine - 1);
    const hi = Math.min(lines.length, endLine);
    for (let i = lo; i < hi; i++) {
      const ln = lines[i];
      for (const pm of ln.matchAll(/[(,]\s*(?:\.\.\.)?([A-Za-z_\\][\w\\]*)\s+&?(?:\.\.\.)?\$(\w+)/g)) {
        const t = baseType(pm[1]);
        if (/^[A-Z]/.test(t)) m.set(pm[2], t);
      }
      for (const vm of ln.matchAll(/\$(\w+)\s*=\s*new\s+\\?([A-Za-z_\\][\w\\]*)/g)) m.set(vm[1], baseType(vm[2]));
    }
    return m;
  }

  /**
   * Namespace-stripped base class name of a PHP type expression, or undefined
   * when the type is scalar/keyword-like (string, int, self, ...) and cannot
   * name a project class. Unions take the first class-like member.
   */
  private phpBaseTypeName(raw?: string): string | undefined {
    if (!raw) return undefined;
    for (const part of raw.replace(/^\?/, '').split('|')) {
      const base = (part.trim().replace(/^\\+/, '').split('\\').pop() || '').trim();
      if (/^[A-Z][A-Za-z0-9_]*$/.test(base)) return base;
    }
    return undefined;
  }

  /**
   * One pass over the project's PHP files (plus Symfony service config)
   * building the evidence needed to resolve calls across service boundaries:
   * property/constructor-injection types, interface -> implementation
   * candidates, and Doctrine entity -> repository class bindings.
   * Every fact recorded here is read directly from source — nothing is
   * guessed from names.
   */
  private async buildPhpTypeIndex(projectPath: string, phpFiles: string[]): Promise<PhpTypeIndex> {
    const classInfoByName = new Map<string, PhpClassTypeInfo>();
    const implsByInterface = new Map<string, string[]>();
    const repoClassByEntity = new Map<string, string>();
    const bindingByInterface = new Map<string, string>();

    const typeDeclRe = /^(?:(abstract|final)\s+)?(class|interface|trait|enum)\s+([A-Za-z_][\w]*)(?:\s*:\s*\w+)?(?:\s+extends\s+([\w\\,\s]+?))?(?:\s+implements\s+([\w\\,\s]+?))?\s*(?:\{|$)/;
    const propertyRe = /(?:public|private|protected)(?:\s+(?:static|readonly))*\s+(\??[A-Za-z_\\][\w\\|?]*)\s+\$(\w+)/;
    const untypedPropertyRe = /^(?:public|private|protected)(?:\s+(?:static|readonly))*\s+\$(\w+)/;
    const repoAttrRe = /repositoryClass\s*[:=]\s*(?:\\?([\w\\]+)::class|["']\\?([\w\\]+)["'])/;

    for (const file of phpFiles) {
      const fullPath = path.isAbsolute(file) ? file : path.join(projectPath, file);
      let content: string;
      try {
        content = await this.readFileCached(fullPath);
      } catch {
        continue;
      }
      const lines = content.split('\n');

      let current: PhpClassTypeInfo | undefined;
      let currentEnd = -1;
      let pendingRepoClass: string | undefined;
      let pendingVarType: string | undefined;
      let sigAccum: string | null = null;
      let sigDepth = 0;
      let lastSigParamTypes: Map<string, string> | undefined;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (current && i + 1 > currentEnd) current = undefined;

        // Doctrine repository binding evidence lives in attributes/annotations
        // (often inside docblocks), so scan for it before skipping comments.
        const repoMatch = line.match(repoAttrRe);
        if (repoMatch) pendingRepoClass = this.phpBaseTypeName(repoMatch[1] || repoMatch[2]);
        const varMatch = line.match(/@var\s+([\w\\|?]+)/);
        if (varMatch) pendingVarType = varMatch[1];

        if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;

        if (/\b(?:class|interface|trait|enum)\s+[A-Za-z_]/.test(line)) {
          const decl = line.match(typeDeclRe);
          if (decl) {
            const kind = decl[2];
            const name = decl[3];
            const extendsList = (decl[4] || '').split(',').map(s => this.phpBaseTypeName(s)).filter((s): s is string => !!s);
            const implementsList = (decl[5] || '').split(',').map(s => this.phpBaseTypeName(s)).filter((s): s is string => !!s);
            current = {
              name,
              isInterface: kind === 'interface',
              isAbstract: decl[1] === 'abstract',
              extendsName: kind === 'interface' ? undefined : extendsList[0],
              // For interfaces, `extends` lists parent interfaces.
              interfaces: kind === 'interface' ? extendsList : implementsList,
              traits: [],
              propertyTypes: new Map(),
              methodReturnTypes: new Map()
            };
            currentEnd = this.findBlockEnd(lines, i);
            if (!classInfoByName.has(name)) classInfoByName.set(name, current);
            if (pendingRepoClass && kind === 'class') {
              if (!repoClassByEntity.has(name)) repoClassByEntity.set(name, pendingRepoClass);
              pendingRepoClass = undefined;
            }
            pendingVarType = undefined;
            lastSigParamTypes = undefined;
            continue;
          }
        }

        if (!current) continue;

        // Trait usage inside a class body: `use FooTrait;` / `use A, B;`
        const traitUse = line.match(/^use\s+([\w\\]+(?:\s*,\s*[\w\\]+)*)\s*;/);
        if (traitUse) {
          for (const t of traitUse[1].split(',')) {
            const base = this.phpBaseTypeName(t);
            if (base) current.traits.push(base);
          }
          continue;
        }

        // Typed property declarations AND promoted constructor params share
        // one shape: `<visibility> [static|readonly] Type $name`.
        const prop = line.match(propertyRe);
        if (prop) {
          const t = this.phpBaseTypeName(prop[1]);
          if (t && !current.propertyTypes.has(prop[2])) current.propertyTypes.set(prop[2], t);
          pendingVarType = undefined;
        } else {
          const untyped = line.match(untypedPropertyRe);
          if (untyped && pendingVarType) {
            const t = this.phpBaseTypeName(pendingVarType);
            if (t && !current.propertyTypes.has(untyped[1])) current.propertyTypes.set(untyped[1], t);
            pendingVarType = undefined;
          }
        }

        // Accumulate method signatures (they span lines in real Symfony code)
        // so constructor-assignment injection `$this->x = $x;` can inherit
        // the constructor param's declared type.
        if (sigAccum === null && /function\s+\w+\s*\(/.test(line)) {
          sigAccum = '';
          sigDepth = 0;
        }
        if (sigAccum !== null) {
          sigAccum += ' ' + line;
          for (const ch of line) {
            if (ch === '(') sigDepth++;
            else if (ch === ')') sigDepth--;
          }
          if (sigDepth <= 0 && sigAccum.includes('(')) {
            lastSigParamTypes = new Map();
            const sigParams = sigAccum.slice(sigAccum.indexOf('('));
            for (const pm of sigParams.matchAll(/(\??[A-Za-z_\\][\w\\|?]*)\s+&?(?:\.\.\.)?\$(\w+)/g)) {
              const t = this.phpBaseTypeName(pm[1]);
              if (t) lastSigParamTypes.set(pm[2], t);
            }
            // Declared return type — evidence for typing fluent/assigned
            // call results (`$qb = $this->repo->createQueryBuilder(...)`).
            const sigHead = sigAccum.match(/function\s+(\w+)\s*\(/);
            const closeParen = sigParams.lastIndexOf(')');
            const returnDecl = closeParen >= 0 ? sigParams.slice(closeParen + 1).match(/^\s*:\s*(\??[\w\\|]+)/) : null;
            if (sigHead && returnDecl) {
              const raw = returnDecl[1].replace(/^\?/, '');
              // Fluent builders declare `self`/`static` — that IS this class.
              const rt = raw === 'self' || raw === 'static' ? current.name : this.phpBaseTypeName(raw);
              if (rt && !current.methodReturnTypes.has(sigHead[1])) current.methodReturnTypes.set(sigHead[1], rt);
            }
            sigAccum = null;
          }
          if (sigAccum !== null) continue;
        }

        const assign = line.match(/\$this->(\w+)\s*=\s*\$(\w+)\s*[;,]?\s*$/);
        if (assign && lastSigParamTypes) {
          const t = lastSigParamTypes.get(assign[2]);
          if (t && !current.propertyTypes.has(assign[1])) current.propertyTypes.set(assign[1], t);
        }

        // ServiceEntityRepository convention: the repository names its entity.
        const parentCtor = line.match(/parent::__construct\(\s*\$\w+\s*,\s*\\?([\w\\]+)::class/);
        if (parentCtor) {
          const entity = this.phpBaseTypeName(parentCtor[1]);
          if (entity && !repoClassByEntity.has(entity)) repoClassByEntity.set(entity, current.name);
        }
      }
    }

    // interface -> implementation candidates. Interface inheritance counts:
    // a class implementing IChild also implements everything IChild extends.
    const expandInterfaces = (names: string[]): Set<string> => {
      const out = new Set<string>();
      const queue = [...names];
      while (queue.length) {
        const n = queue.pop()!;
        if (out.has(n)) continue;
        out.add(n);
        const info = classInfoByName.get(n);
        if (info?.isInterface) queue.push(...info.interfaces);
      }
      return out;
    };
    for (const info of classInfoByName.values()) {
      if (info.isInterface || info.interfaces.length === 0) continue;
      for (const iface of expandInterfaces(info.interfaces)) {
        if (!classInfoByName.get(iface)?.isInterface) continue;
        const impls = implsByInterface.get(iface) || [];
        impls.push(info.name);
        implsByInterface.set(iface, impls);
      }
    }
    // Prefer concrete implementations when counting candidates: an abstract
    // base implementing the interface is not the object DI will inject.
    for (const [iface, impls] of implsByInterface) {
      const concrete = impls.filter(name => !classInfoByName.get(name)?.isAbstract);
      if (concrete.length > 0 && concrete.length < impls.length) implsByInterface.set(iface, concrete);
    }

    await this.collectPhpServiceBindings(projectPath, bindingByInterface);

    return { classInfoByName, implsByInterface, repoClassByEntity, bindingByInterface };
  }

  /**
   * Symfony services.yaml alias evidence for interface -> implementation
   * binding when multiple implementations exist. Only explicit aliases are
   * trusted: `Foo\BarInterface: '@Foo\Baz'` or a nested `alias:` key.
   */
  private async collectPhpServiceBindings(projectPath: string, out: Map<string, string>): Promise<void> {
    let configFiles: string[] = [];
    try {
      configFiles = await glob(
        ['config/**/*.yaml', 'config/**/*.yml', 'app/config/**/*.yml', 'services.yaml', 'services.yml'],
        { cwd: projectPath, ignore: ['**/vendor/**', '**/node_modules/**'], nodir: true }
      );
    } catch {
      return;
    }
    configFiles.sort();
    for (const file of configFiles) {
      let content: string;
      try {
        content = await this.readFileCached(path.join(projectPath, file));
      } catch {
        continue;
      }
      const lines = content.split('\n');
      let pendingKey: string | undefined;
      for (const rawLine of lines) {
        const line = rawLine.replace(/#.*$/, '');
        const inline = line.match(/^\s*\\?([\w\\]+Interface)\s*:\s*['"]?@\\?([\w\\]+)['"]?\s*$/);
        if (inline) {
          const iface = this.phpBaseTypeName(inline[1]);
          const impl = this.phpBaseTypeName(inline[2]);
          if (iface && impl && !out.has(iface)) out.set(iface, impl);
          pendingKey = undefined;
          continue;
        }
        const key = line.match(/^\s*\\?([\w\\]+Interface)\s*:\s*$/);
        if (key) {
          pendingKey = this.phpBaseTypeName(key[1]);
          continue;
        }
        if (pendingKey) {
          const alias = line.match(/^\s+alias\s*:\s*['"]?@?\\?([\w\\]+)['"]?\s*$/);
          if (alias) {
            const impl = this.phpBaseTypeName(alias[1]);
            if (impl && !out.has(pendingKey)) out.set(pendingKey, impl);
          }
          if (line.trim() !== '') pendingKey = undefined;
        }
      }
    }
  }

  /**
   * Resolve a declared type to the class node a call on it would dispatch to.
   * Interfaces bind to their implementation ONLY on concrete evidence: an
   * explicit services.yaml alias, or exactly one implementation in the repo.
   * Ambiguous interfaces resolve to the interface node itself (the call edge
   * then truthfully targets the declared method, not a guessed impl).
   */
  private resolvePhpTypeToClassNode(
    typeName: string | undefined,
    index: PhpTypeIndex,
    firstClassByName: (name?: string) => CASNode | undefined
  ): CASNode | undefined {
    const base = this.phpBaseTypeName(typeName);
    if (!base) return undefined;
    const node = firstClassByName(base);
    const isInterface = node?.type === 'interface' || index.classInfoByName.get(base)?.isInterface === true;
    if (isInterface) {
      const bound = index.bindingByInterface.get(base);
      if (bound) {
        const implNode = firstClassByName(bound);
        if (implNode) return implNode;
      }
      const impls = index.implsByInterface.get(base);
      if (impls && impls.length === 1) {
        const implNode = firstClassByName(impls[0]);
        if (implNode) return implNode;
      }
    }
    return node;
  }

  /**
   * Find a method on a class or anywhere up its inheritance surface:
   * the class itself, its traits, then the extends chain (each parent's
   * traits included). Bounded and cycle-guarded.
   */
  private findPhpMethodInHierarchy(
    startClass: CASNode | undefined,
    methodName: string | undefined,
    index: PhpTypeIndex,
    firstClassByName: (name?: string) => CASNode | undefined,
    firstMethodInClass: (classId: string, name?: string) => CASNode | undefined
  ): CASNode | undefined {
    if (!startClass || !methodName) return undefined;
    const visited = new Set<string>();
    let cursor: CASNode | undefined = startClass;
    for (let depth = 0; cursor && depth < 8; depth++) {
      if (visited.has(cursor.name)) break;
      visited.add(cursor.name);
      const direct = firstMethodInClass(cursor.id, methodName);
      if (direct) return direct;
      const info = index.classInfoByName.get(cursor.name);
      for (const traitName of info?.traits || []) {
        const traitNode = firstClassByName(traitName);
        if (traitNode) {
          const traitMethod = firstMethodInClass(traitNode.id, methodName);
          if (traitMethod) return traitMethod;
        }
      }
      const parentName: string | undefined = info?.extendsName
        || this.phpBaseTypeName(cursor.metadata?.attributes?.extendsClass as string | undefined);
      cursor = parentName ? firstClassByName(parentName) : undefined;
    }
    return undefined;
  }

  /** Declared type of `$this->prop`, searched up the inheritance chain. */
  private phpPropertyTypeOf(className: string | undefined, prop: string, index: PhpTypeIndex): string | undefined {
    let cursor = className ? index.classInfoByName.get(className) : undefined;
    const visited = new Set<string>();
    for (let depth = 0; cursor && depth < 8; depth++) {
      if (visited.has(cursor.name)) break;
      visited.add(cursor.name);
      const t = cursor.propertyTypes.get(prop);
      if (t) return t;
      for (const traitName of cursor.traits) {
        const traitInfo = index.classInfoByName.get(traitName);
        const traitType = traitInfo?.propertyTypes.get(prop);
        if (traitType) return traitType;
      }
      cursor = cursor.extendsName ? index.classInfoByName.get(cursor.extendsName) : undefined;
    }
    return undefined;
  }

  /** Declared return type of `Class::method`, searched up the inheritance chain. */
  private phpMethodReturnTypeOf(className: string | undefined, method: string, index: PhpTypeIndex): string | undefined {
    let cursor = className ? index.classInfoByName.get(className) : undefined;
    const visited = new Set<string>();
    for (let depth = 0; cursor && depth < 8; depth++) {
      if (visited.has(cursor.name)) break;
      visited.add(cursor.name);
      const t = cursor.methodReturnTypes.get(method);
      if (t) return t === 'self' || t === 'static' ? cursor.name : t;
      for (const traitName of cursor.traits) {
        const traitType = index.classInfoByName.get(traitName)?.methodReturnTypes.get(method);
        if (traitType) return traitType;
      }
      cursor = cursor.extendsName ? index.classInfoByName.get(cursor.extendsName) : undefined;
    }
    return undefined;
  }

  /**
   * Per-method receiver typing (v2 of buildPhpReceiverTypes): typed params
   * from the FULL (multi-line) signature, `new Type()` assignments,
   * `$x = $this->prop` (property's declared type),
   * `$x = ...->getRepository(Entity::class)` (Doctrine repository binding),
   * and `$x = <typed receiver>->method()` (declared return type).
   */
  private buildPhpReceiverTypesV2(
    lines: string[],
    startLine: number,
    endLine: number,
    containingClassName: string | undefined,
    index: PhpTypeIndex
  ): Map<string, string> {
    const m = new Map<string, string>();
    const lo = Math.max(0, startLine - 1);
    const hi = Math.min(lines.length, endLine);

    // Signature: accumulate from the declaration line until parens balance.
    let sig = '';
    let depth = 0;
    for (let i = lo; i < hi && i < lo + 60; i++) {
      sig += ' ' + lines[i];
      for (const ch of lines[i]) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
      }
      if (depth <= 0 && sig.includes('(')) break;
    }
    const paren = sig.indexOf('(');
    if (paren >= 0) {
      for (const pm of sig.slice(paren).matchAll(/(\??[A-Za-z_\\][\w\\|?]*)\s+&?(?:\.\.\.)?\$(\w+)/g)) {
        const t = this.phpBaseTypeName(pm[1]);
        if (t) m.set(pm[2], t);
      }
    }

    for (let i = lo; i < hi; i++) {
      const ln = lines[i];
      for (const vm of ln.matchAll(/\$(\w+)\s*=\s*new\s+\\?([A-Za-z_\\][\w\\]*)/g)) {
        const t = this.phpBaseTypeName(vm[2]);
        if (t) m.set(vm[1], t);
      }
      for (const rm of ln.matchAll(/\$(\w+)\s*=\s*[^=;]*->getRepository\(\s*\\?([\w\\]+)::class/g)) {
        const entity = this.phpBaseTypeName(rm[2]);
        const repo = entity ? index.repoClassByEntity.get(entity) : undefined;
        if (repo) m.set(rm[1], repo);
      }
      for (const pm of ln.matchAll(/\$(\w+)\s*=\s*\$this->(\w+)\s*;/g)) {
        const t = this.phpPropertyTypeOf(containingClassName, pm[2], index);
        if (t) m.set(pm[1], t);
      }
      // Return-type evidence: `$x = $this->method(...)`, `$x = $this->prop->method(...)`,
      // `$x = $var->method(...)` — the declared return type types the variable.
      for (const am of ln.matchAll(/\$(\w+)\s*=\s*\$this->(\w+)(->(\w+))?\s*\(/g)) {
        if (am[3]) {
          const propType = this.phpPropertyTypeOf(containingClassName, am[2], index);
          const rt = propType ? this.phpMethodReturnTypeOf(propType, am[4], index) : undefined;
          if (rt) m.set(am[1], rt);
        } else {
          const rt = this.phpMethodReturnTypeOf(containingClassName, am[2], index);
          if (rt) m.set(am[1], rt);
        }
      }
      for (const am of ln.matchAll(/\$(\w+)\s*=\s*\$(\w+)->(\w+)\s*\(/g)) {
        if (am[2] === 'this') continue;
        const recvType = m.get(am[2]);
        const rt = recvType ? this.phpMethodReturnTypeOf(recvType, am[3], index) : undefined;
        if (rt) m.set(am[1], rt);
      }
    }
    return m;
  }

  private async analyzeCallGraph(projectPath: string, nodes: CASNode[], edges: CASEdge[], exitPoints: CASExitPoint[]): Promise<void> {
    const phpFiles = await glob(['**/*.php'], {
      cwd: projectPath,
      ignore: this.getPHPIgnorePatterns({ projectPath }),
      nodir: true
    });
    phpFiles.sort();

    const methodNodes = nodes.filter(n => n.type === 'method' || n.type === 'function');
    const classNodes = nodes.filter(n => n.type === 'class' || n.type === 'interface' || n.type === 'trait');
    const edgeIds = new Set(edges.map(edge => edge.id));
    const exitIds = new Set(exitPoints.map(exit => exit.id));
    const classIds = new Set(classNodes.map(node => node.id));
    const methodNodesById = new Map(methodNodes.map(node => [node.id, node]));
    const methodNodesByName = new Map<string, CASNode[]>();
    const classNodesByName = new Map<string, CASNode[]>();
    const methodNodesByFileAndName = new Map<string, CASNode[]>();
    const methodNodesByFile = new Map<string, CASNode[]>();
    const methodsByClassId = new Map<string, CASNode[]>();

    for (const method of methodNodes) {
      const byName = methodNodesByName.get(method.name) || [];
      byName.push(method);
      methodNodesByName.set(method.name, byName);
      if (method.source?.file) {
        const byFileOnly = methodNodesByFile.get(method.source.file) || [];
        byFileOnly.push(method);
        methodNodesByFile.set(method.source.file, byFileOnly);
        const key = `${method.source.file}:${method.name}`;
        const byFile = methodNodesByFileAndName.get(key) || [];
        byFile.push(method);
        methodNodesByFileAndName.set(key, byFile);
      }
    }

    for (const classNode of classNodes) {
      const byName = classNodesByName.get(classNode.name) || [];
      byName.push(classNode);
      classNodesByName.set(classNode.name, byName);
    }

    for (const edge of edges) {
      if ((edge.type === 'has_method' || edge.type === 'declares') && classIds.has(edge.source)) {
        const method = methodNodesById.get(edge.target);
        if (method) {
          const methods = methodsByClassId.get(edge.source) || [];
          methods.push(method);
          methodsByClassId.set(edge.source, methods);
        }
      }
    }

    // Cross-boundary resolution evidence (DI interface bindings, Doctrine
    // repositories, property/constructor injection types) — one pass over
    // the same files every path below re-reads from cache.
    const typeIndex = await this.buildPhpTypeIndex(projectPath, phpFiles);

    if (phpFiles.length > 1000 || methodNodes.length > 12000) {
      await this.analyzeCallGraphFastFallback(projectPath, phpFiles, nodes, edges, exitPoints, methodNodes, classNodes, typeIndex);
      return;
    }

    const firstClassByName = (name?: string) => name ? classNodesByName.get(name)?.[0] : undefined;
    const firstMethodByFileAndName = (file: string, name?: string) => name ? methodNodesByFileAndName.get(`${file}:${name}`)?.[0] : undefined;
    const firstMethodInClass = (classId: string, name?: string) => {
      if (!name) return undefined;
      return (methodsByClassId.get(classId) || []).find(method => method.name === name);
    };
    const pushEdgeOnce = (edge: CASEdge) => {
      if (edgeIds.has(edge.id)) return;
      edgeIds.add(edge.id);
      edges.push(edge);
    };
    const pushExitOnce = (exit: CASExitPoint) => {
      if (exitIds.has(exit.id)) return;
      exitIds.add(exit.id);
      exitPoints.push(exit);
    };

    for (const file of phpFiles) {
      const fullPath = path.join(projectPath, file);

      const ast = await this.astRunner.parsePHPAST(fullPath);
      if (!ast) {
        await this.analyzeCallGraphFallback(fullPath, file, nodes, edges, exitPoints, methodNodes, classNodes, projectPath);
        continue;
      }

      this.astCache.set(file, ast);
      const currentNamespace = ast.namespace || 'global';

      if (ast.calls) {
        const fileLines = (await this.readFileCached(fullPath)).split('\n');
        const recvTypesByMethodId = new Map<string, Map<string, string>>();
        for (const call of ast.calls) {
          // The caller is the method whose body spans this call's line — NOT a
          // same-named method (call.method is the TARGET, not the caller).
          const callerMethod = (methodNodesByFile.get(fullPath) || []).find(n =>
              n.source?.line !== undefined && n.source.line <= call.line &&
              n.source?.end_line !== undefined && n.source.end_line >= call.line
            );

          if (!callerMethod) continue;

          let targetMethod: CASNode | undefined;

          if (call.receiver !== undefined) {
            // Member call `$recv->method()`: resolve $recv to its class. `$this`
            // (and `self`/`static`) means the containing class; `$this->prop`
            // resolves through the property's declared type (constructor/DI
            // injection); Doctrine `->getRepository(E::class)` chains resolve
            // to E's repository class; any other var is type-resolved from
            // scope. Interface types bind to their implementation only on
            // evidence (unique impl or services.yaml alias).
            const recv = call.receiver;
            let recvType: string | undefined;
            const repoChain = recv.match(/getRepository\(\s*\\?([\w\\]+)(?:::class)?\s*\)$/);
            const thisProp = recv.match(/^this->(\w+)$/);
            const thisCallChain = recv.match(/^this->(\w+)\([^()]*\)$/);
            const propCallChain = recv.match(/^this->(\w+)->(\w+)\([^()]*\)$/);
            if (recv === 'this' || recv === 'self' || recv === 'static') {
              recvType = call.class;
            } else if (repoChain) {
              const entity = this.phpBaseTypeName(repoChain[1]);
              recvType = entity ? typeIndex.repoClassByEntity.get(entity) : undefined;
            } else if (thisProp) {
              recvType = this.phpPropertyTypeOf(call.class, thisProp[1], typeIndex);
            } else if (thisCallChain) {
              recvType = this.phpMethodReturnTypeOf(call.class, thisCallChain[1], typeIndex);
            } else if (propCallChain) {
              const propType = this.phpPropertyTypeOf(call.class, propCallChain[1], typeIndex);
              recvType = propType ? this.phpMethodReturnTypeOf(propType, propCallChain[2], typeIndex) : undefined;
            } else if (/^\w+$/.test(recv)) {
              let map = recvTypesByMethodId.get(callerMethod.id);
              if (!map) {
                map = this.buildPhpReceiverTypesV2(
                  fileLines,
                  callerMethod.source?.line ?? 1,
                  callerMethod.source?.end_line ?? fileLines.length,
                  call.class,
                  typeIndex
                );
                recvTypesByMethodId.set(callerMethod.id, map);
              }
              recvType = map.get(recv);
            }
            if (recvType && call.method) {
              const targetClass = this.resolvePhpTypeToClassNode(recvType, typeIndex, firstClassByName);
              targetMethod = this.findPhpMethodInHierarchy(targetClass, call.method, typeIndex, firstClassByName, firstMethodInClass);
            }
          } else if (call.class && call.method) {
            // Static/scoped call `Foo::bar()` — call.class IS the target class.
            const targetClass = firstClassByName(this.phpBaseTypeName(call.class));
            targetMethod = this.findPhpMethodInHierarchy(targetClass, call.method, typeIndex, firstClassByName, firstMethodInClass);
          } else if (call.function) {
            // Bare-name calls can only be standalone functions in PHP —
            // binding them to any same-named class METHOD fabricates edges.
            targetMethod = (methodNodesByName.get(call.function) || []).find(n => n.type === 'function');
          }

          if (targetMethod && targetMethod.id !== callerMethod.id) {
            const callEdgeId = `call_${callerMethod.id}_to_${targetMethod.id}_line_${call.line}`;
            pushEdgeOnce(this.createEdge(
                callEdgeId,
                callerMethod.id,
                targetMethod.id,
                'calls',
                'behavior',
                {
                  line: call.line,
                  callType: call.class ? 'static' : call.method ? 'method' : 'function',
                  targetClass: call.class,
                  targetMethod: call.method || call.function
                }
              ));
          } else if (this.isExternalLibraryCall(call.class || call.function || '', call.method || '', currentNamespace)) {
            const exitId = `exit_call_${callerMethod.id}_${call.class || call.function || 'unknown'}_${call.method || ''}_${call.line}`;
            pushExitOnce(this.createExitPoint(
                exitId,
                callerMethod.id,
                'sdk',
                call.class && call.method ? `External call: ${call.class}::${call.method}` :
                call.function ? `External call: ${call.function}` : 'External call',
                `Library call to ${this.identifyPHPLibrary(call.class || call.function || '')}`,
                call.class ? { sdk: call.class } : undefined,
                (call.method || call.function) ? { method: call.method || call.function } : undefined,
                {
                  targetClass: call.class,
                  targetMethod: call.method,
                  targetFunction: call.function,
                  line: call.line,
                  library: this.identifyPHPLibrary(call.class || call.function || '')
                }
              ));
          }
        }
      }
    }
  }

  /** PHP keywords/constructs a bare `name(` match must never treat as a call. */
  private static readonly PHP_CALL_KEYWORDS = new Set([
    'if', 'elseif', 'else', 'while', 'for', 'foreach', 'switch', 'match', 'catch',
    'fn', 'function', 'array', 'list', 'isset', 'unset', 'empty', 'echo', 'print',
    'exit', 'die', 'return', 'new', 'use', 'require', 'include', 'require_once',
    'include_once', 'static', 'parent', 'self', 'and', 'or', 'xor', 'clone',
    'throw', 'yield', 'declare', 'compact', 'extract', 'strict_types'
  ]);

  /**
   * All call sites a regex pass can see on one line, classified by receiver
   * shape so the resolver can apply the right typing evidence. Shared by the
   * fast fallback (whale repos) and the AST-failure fallback.
   */
  private collectPhpLineCallMatches(line: string): Array<{
    kind: 'this' | 'this-prop' | 'repo' | 'var' | 'self' | 'parent' | 'static' | 'scoped' | 'new' | 'plain'
      | 'this-call-chain' | 'prop-call-chain' | 'var-call-chain';
    objectOrClass: string;
    methodName?: string;
    chainMethod?: string;
  }> {
    const matches: Array<{ kind: any; objectOrClass: string; methodName?: string; chainMethod?: string }> = [];

    // `$this->prop->method()` — property receiver (constructor/DI injection).
    for (const m of line.matchAll(/\$this->(\w+)->(\w+)\s*\(/g)) {
      matches.push({ kind: 'this-prop', objectOrClass: m[1], methodName: m[2] });
    }
    // One-hop fluent chains, typed by the first call's declared return type:
    // `$this->m1(...)->m2(`, `$this->prop->m1(...)->m2(`, `$var->m1(...)->m2(`.
    // Only paren-free first arguments — regex cannot balance nesting.
    for (const m of line.matchAll(/\$this->(\w+)\s*\(([^()]*)\)\s*->\s*(\w+)\s*\(/g)) {
      matches.push({ kind: 'this-call-chain', objectOrClass: m[1], chainMethod: m[1], methodName: m[3] });
    }
    for (const m of line.matchAll(/\$this->(\w+)->(\w+)\s*\(([^()]*)\)\s*->\s*(\w+)\s*\(/g)) {
      matches.push({ kind: 'prop-call-chain', objectOrClass: m[1], chainMethod: m[2], methodName: m[4] });
    }
    for (const m of line.matchAll(/\$(\w+)->(\w+)\s*\(([^()]*)\)\s*->\s*(\w+)\s*\(/g)) {
      if (m[1] === 'this') continue;
      matches.push({ kind: 'var-call-chain', objectOrClass: `$${m[1]}`, chainMethod: m[2], methodName: m[4] });
    }
    // Doctrine `...->getRepository(Entity::class)->method()` chains.
    for (const m of line.matchAll(/->getRepository\(\s*\\?([\w\\]+)(?:::class)?\s*\)\s*->\s*(\w+)\s*\(/g)) {
      matches.push({ kind: 'repo', objectOrClass: m[1], methodName: m[2] });
    }
    // `$var->method()` — includes `$this->method()` (kind 'this').
    for (const m of line.matchAll(/(\$\w+)->(\w+)\s*\(/g)) {
      if (m[1] === '$this') matches.push({ kind: 'this', objectOrClass: '$this', methodName: m[2] });
      else matches.push({ kind: 'var', objectOrClass: m[1], methodName: m[2] });
    }
    // `Foo::bar()` / self:: / parent:: / static::
    for (const m of line.matchAll(/([\w\\]+)::(\w+)\s*\(/g)) {
      if (m[1] === 'self' || m[1] === 'parent' || m[1] === 'static') {
        matches.push({ kind: m[1], objectOrClass: m[1], methodName: m[2] });
      } else {
        matches.push({ kind: 'scoped', objectOrClass: m[1], methodName: m[2] });
      }
    }
    // `new Foo(...)`
    for (const m of line.matchAll(/new\s+\\?([\w\\]+)\s*\(/g)) {
      matches.push({ kind: 'new', objectOrClass: m[1], methodName: '__construct' });
    }
    // Bare `name(...)` — a standalone function call. The lookbehind rejects
    // method/static/variable receivers; keyword and declaration hits are
    // filtered here so they can never bind to a same-named class method.
    for (const m of line.matchAll(/(?<![\w$>:\\])([a-zA-Z_]\w*)\s*\(/g)) {
      const name = m[1];
      if (PHPAnalyzer.PHP_CALL_KEYWORDS.has(name)) continue;
      const before = line.slice(0, m.index ?? 0);
      if (/(?:function|new)\s+$/.test(before)) continue;
      matches.push({ kind: 'plain', objectOrClass: name });
    }
    return matches;
  }

  /**
   * Resolve one regex-matched call site to a target method node using the
   * project's type evidence. Returns undefined (abstains) when there is no
   * concrete binding fact — never guesses across same-named candidates.
   */
  private resolvePhpFallbackCallTarget(
    match: { kind: string; objectOrClass: string; methodName?: string; chainMethod?: string },
    callerMethod: CASNode,
    ctx: {
      typeIndex: PhpTypeIndex;
      firstClassByName: (name?: string) => CASNode | undefined;
      firstMethodInClass: (classId: string, name?: string) => CASNode | undefined;
      methodNodesByName: Map<string, CASNode[]>;
      classByMethodId: Map<string, CASNode>;
      receiverTypesFor: (callerMethod: CASNode) => Map<string, string>;
    }
  ): CASNode | undefined {
    const { typeIndex, firstClassByName, firstMethodInClass, methodNodesByName, classByMethodId } = ctx;
    const inHierarchy = (cls: CASNode | undefined, method?: string) =>
      this.findPhpMethodInHierarchy(cls, method, typeIndex, firstClassByName, firstMethodInClass);
    const viaType = (typeName?: string, method?: string) =>
      inHierarchy(this.resolvePhpTypeToClassNode(typeName, typeIndex, firstClassByName), method);

    switch (match.kind) {
      case 'this':
      case 'self':
      case 'static':
        return inHierarchy(classByMethodId.get(callerMethod.id), match.methodName);
      case 'parent': {
        const containing = classByMethodId.get(callerMethod.id);
        const parentName = typeIndex.classInfoByName.get(containing?.name || '')?.extendsName
          || this.phpBaseTypeName(containing?.metadata?.attributes?.extendsClass as string | undefined);
        return inHierarchy(firstClassByName(parentName), match.methodName);
      }
      case 'this-prop': {
        const containing = classByMethodId.get(callerMethod.id);
        const propType = this.phpPropertyTypeOf(containing?.name, match.objectOrClass, typeIndex);
        return viaType(propType, match.methodName);
      }
      case 'repo': {
        const entity = this.phpBaseTypeName(match.objectOrClass);
        const repoClass = entity ? typeIndex.repoClassByEntity.get(entity) : undefined;
        return viaType(repoClass, match.methodName);
      }
      case 'var': {
        const varType = ctx.receiverTypesFor(callerMethod).get(match.objectOrClass.replace(/^\$/, ''));
        return viaType(varType, match.methodName);
      }
      case 'this-call-chain': {
        const containing = classByMethodId.get(callerMethod.id);
        const rt = this.phpMethodReturnTypeOf(containing?.name, match.chainMethod || '', typeIndex);
        return viaType(rt, match.methodName);
      }
      case 'prop-call-chain': {
        const containing = classByMethodId.get(callerMethod.id);
        const propType = this.phpPropertyTypeOf(containing?.name, match.objectOrClass, typeIndex);
        const rt = propType ? this.phpMethodReturnTypeOf(propType, match.chainMethod || '', typeIndex) : undefined;
        return viaType(rt, match.methodName);
      }
      case 'var-call-chain': {
        const varType = ctx.receiverTypesFor(callerMethod).get(match.objectOrClass.replace(/^\$/, ''));
        const rt = varType ? this.phpMethodReturnTypeOf(varType, match.chainMethod || '', typeIndex) : undefined;
        return viaType(rt, match.methodName);
      }
      case 'scoped':
      case 'new':
        return inHierarchy(firstClassByName(this.phpBaseTypeName(match.objectOrClass)), match.methodName);
      case 'plain':
        // Bare-name calls can only be standalone functions in PHP — binding
        // them to a same-named class METHOD would fabricate edges.
        return (methodNodesByName.get(match.objectOrClass) || []).find(n => n.type === 'function');
      default:
        return undefined;
    }
  }

  private async analyzeCallGraphFastFallback(
    projectPath: string,
    phpFiles: string[],
    nodes: CASNode[],
    edges: CASEdge[],
    exitPoints: CASExitPoint[],
    methodNodes: CASNode[],
    classNodes: CASNode[],
    prebuiltTypeIndex?: PhpTypeIndex
  ): Promise<void> {
    const typeIndex = prebuiltTypeIndex ?? await this.buildPhpTypeIndex(projectPath, phpFiles);
    const edgeIds = new Set(edges.map(edge => edge.id));
    const exitIds = new Set(exitPoints.map(exit => exit.id));
    const classIds = new Set(classNodes.map(node => node.id));
    const methodNodesById = new Map(methodNodes.map(node => [node.id, node]));
    const classNodesById = new Map(classNodes.map(node => [node.id, node]));
    const methodNodesByName = new Map<string, CASNode[]>();
    const classNodesByName = new Map<string, CASNode[]>();
    const methodsByClassId = new Map<string, CASNode[]>();
    const classByMethodId = new Map<string, CASNode>();
    const methodsByFile = new Map<string, CASNode[]>();

    for (const method of methodNodes) {
      const methods = methodNodesByName.get(method.name) || [];
      methods.push(method);
      methodNodesByName.set(method.name, methods);
      if (method.source?.file) {
        const fileMethods = methodsByFile.get(method.source.file) || [];
        fileMethods.push(method);
        methodsByFile.set(method.source.file, fileMethods);
      }
    }

    for (const classNode of classNodes) {
      const classes = classNodesByName.get(classNode.name) || [];
      classes.push(classNode);
      classNodesByName.set(classNode.name, classes);
    }

    for (const edge of edges) {
      if ((edge.type === 'has_method' || edge.type === 'declares') && classIds.has(edge.source)) {
        const method = methodNodesById.get(edge.target);
        const classNode = classNodesById.get(edge.source);
        if (!method) continue;
        const methods = methodsByClassId.get(edge.source) || [];
        methods.push(method);
        methodsByClassId.set(edge.source, methods);
        if (classNode) classByMethodId.set(method.id, classNode);
      }
    }

    const firstClassByName = (name?: string) => name ? classNodesByName.get(name)?.[0] : undefined;
    const firstMethodInClass = (classId: string, name?: string) => {
      if (!name) return undefined;
      return (methodsByClassId.get(classId) || []).find(method => method.name === name);
    };
    const pushEdgeOnce = (edge: CASEdge) => {
      if (edgeIds.has(edge.id)) return;
      edgeIds.add(edge.id);
      edges.push(edge);
    };
    const pushExitOnce = (exit: CASExitPoint) => {
      if (exitIds.has(exit.id)) return;
      exitIds.add(exit.id);
      exitPoints.push(exit);
    };

    for (const file of phpFiles) {
      const fullPath = path.join(projectPath, file);
      const methodsInFile = methodsByFile.get(fullPath) || [];
      if (methodsInFile.length === 0) continue;

      let content = '';
      try {
        content = await this.readFileCached(fullPath);
      } catch {
        continue;
      }

      const lines = content.split('\n');
      const currentNamespace = this.extractNamespace(content) || 'global';
      const callerForLine = (line: number) => methodsInFile.find(n =>
        n.source?.line !== undefined && n.source.line <= line &&
        n.source?.end_line !== undefined && n.source.end_line >= line
      );
      const recvTypesByMethodId = new Map<string, Map<string, string>>();
      const receiverTypesFor = (callerMethod: CASNode): Map<string, string> => {
        let map = recvTypesByMethodId.get(callerMethod.id);
        if (!map) {
          map = this.buildPhpReceiverTypesV2(
            lines,
            callerMethod.source?.line ?? 1,
            callerMethod.source?.end_line ?? lines.length,
            classByMethodId.get(callerMethod.id)?.name,
            typeIndex
          );
          recvTypesByMethodId.set(callerMethod.id, map);
        }
        return map;
      };

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('(')) continue;

        const functionCalls = this.collectPhpLineCallMatches(line);

        for (const match of functionCalls) {
          const callerMethod = callerForLine(i + 1);
          if (!callerMethod) continue;

          const targetMethod = this.resolvePhpFallbackCallTarget(match, callerMethod, {
            typeIndex,
            firstClassByName,
            firstMethodInClass,
            methodNodesByName,
            classByMethodId,
            receiverTypesFor
          });
          const objectOrClass = match.objectOrClass;
          const methodName = match.methodName;

          if (targetMethod && targetMethod.id !== callerMethod.id) {
            pushEdgeOnce(this.createEdge(
              `call_${callerMethod.id}_to_${targetMethod.id}_${i}`,
              callerMethod.id,
              targetMethod.id,
              'calls',
              'behavior',
              {
                line: i + 1,
                callType: match.kind === 'new' ? 'constructor' :
                  objectOrClass === 'parent' ? 'parent' :
                    objectOrClass === 'self' || objectOrClass === 'static' ? 'static' :
                      objectOrClass === '$this' ? 'internal' :
                        methodName ? 'method' : 'function',
                resolution: match.kind
              }
            ));
          } else if (this.isExternalLibraryCall(objectOrClass, methodName || objectOrClass, currentNamespace)) {
            pushExitOnce(this.createExitPoint(
              `exit_call_${callerMethod.id}_${objectOrClass}_${methodName || 'func'}_${i}`,
              callerMethod.id,
              'sdk',
              methodName ? `External call: ${objectOrClass}::${methodName}` : `External call: ${objectOrClass}`,
              `Library call to ${this.identifyPHPLibrary(objectOrClass)}`,
              undefined,
              undefined,
              {
                targetClass: objectOrClass,
                targetFunction: methodName || objectOrClass,
                line: i + 1,
                library: this.identifyPHPLibrary(objectOrClass)
              }
            ));
          }
        }
      }
    }
  }

  private async analyzeCallGraphFallback(
    fullPath: string,
    file: string,
    nodes: CASNode[],
    edges: CASEdge[],
    exitPoints: CASExitPoint[],
    methodNodes: CASNode[],
    classNodes: CASNode[],
    projectPath: string,
    prebuiltTypeIndex?: PhpTypeIndex
  ): Promise<void> {
    const typeIndex = prebuiltTypeIndex ?? await this.buildPhpTypeIndex(projectPath, [fullPath]);
    const content = await this.readFileCached(fullPath);
    const lines = content.split('\n');
    const currentNamespace = this.extractNamespace(content) || 'global';
    const edgeIds = new Set(edges.map(edge => edge.id));
    const exitIds = new Set(exitPoints.map(exit => exit.id));
    const classIds = new Set(classNodes.map(node => node.id));
    const methodsInFile = methodNodes.filter(method => method.source?.file === fullPath);
    const methodNodesByName = new Map<string, CASNode[]>();
    const classNodesByName = new Map<string, CASNode[]>();
    const methodsByClassId = new Map<string, CASNode[]>();
    const classByMethodId = new Map<string, CASNode>();

    for (const method of methodNodes) {
      const methods = methodNodesByName.get(method.name) || [];
      methods.push(method);
      methodNodesByName.set(method.name, methods);
    }

    for (const classNode of classNodes) {
      const classes = classNodesByName.get(classNode.name) || [];
      classes.push(classNode);
      classNodesByName.set(classNode.name, classes);
    }

    for (const edge of edges) {
      if ((edge.type === 'has_method' || edge.type === 'declares') && classIds.has(edge.source)) {
        const method = methodNodes.find(node => node.id === edge.target);
        const classNode = classNodes.find(node => node.id === edge.source);
        if (method) {
          const methods = methodsByClassId.get(edge.source) || [];
          methods.push(method);
          methodsByClassId.set(edge.source, methods);
        }
        if (method && classNode) {
          classByMethodId.set(method.id, classNode);
        }
      }
    }

    const callerForLine = (line: number) => methodsInFile.find(n =>
      n.source?.line !== undefined && n.source.line <= line &&
      n.source?.end_line !== undefined && n.source.end_line >= line
    );
    const firstClassByName = (name?: string) => name ? classNodesByName.get(name)?.[0] : undefined;
    const firstMethodInClass = (classId: string, name?: string) => {
      if (!name) return undefined;
      return (methodsByClassId.get(classId) || []).find(method => method.name === name);
    };
    const pushEdgeOnce = (edge: CASEdge) => {
      if (edgeIds.has(edge.id)) return;
      edgeIds.add(edge.id);
      edges.push(edge);
    };
    const pushExitOnce = (exit: CASExitPoint) => {
      if (exitIds.has(exit.id)) return;
      exitIds.add(exit.id);
      exitPoints.push(exit);
    };

      const recvTypesByMethodId = new Map<string, Map<string, string>>();
      const receiverTypesFor = (callerMethod: CASNode): Map<string, string> => {
        let map = recvTypesByMethodId.get(callerMethod.id);
        if (!map) {
          map = this.buildPhpReceiverTypesV2(
            lines,
            callerMethod.source?.line ?? 1,
            callerMethod.source?.end_line ?? lines.length,
            classByMethodId.get(callerMethod.id)?.name,
            typeIndex
          );
          recvTypesByMethodId.set(callerMethod.id, map);
        }
        return map;
      };

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const functionCalls = line.includes('(') ? this.collectPhpLineCallMatches(line) : [];

        for (const match of functionCalls) {
          const objectOrClass = match.objectOrClass;
          const methodName = match.methodName;

          const callerMethod = callerForLine(i + 1);

          if (callerMethod) {
            const targetMethod = this.resolvePhpFallbackCallTarget(match, callerMethod, {
              typeIndex,
              firstClassByName,
              firstMethodInClass,
              methodNodesByName,
              classByMethodId,
              receiverTypesFor
            });

            if (targetMethod && targetMethod.id !== callerMethod.id) {
              const callEdgeId = `call_${callerMethod.id}_to_${targetMethod.id}_${i}`;
              pushEdgeOnce(this.createEdge(
                  callEdgeId,
                  callerMethod.id,
                  targetMethod.id,
                  'calls',
                  'behavior',
                  {
                    line: i + 1,
                    callType: match.kind === 'new' ? 'constructor' :
                             objectOrClass === 'parent' ? 'parent' :
                             objectOrClass === 'self' || objectOrClass === 'static' ? 'static' :
                             objectOrClass === '$this' ? 'internal' :
                             methodName ? 'method' : 'function',
                    resolution: match.kind
                  }
                ));
            } else if (this.isExternalLibraryCall(objectOrClass, methodName || objectOrClass, currentNamespace)) {
              const exitId = `exit_call_${callerMethod.id}_${objectOrClass}_${methodName || 'func'}_${i}`;
              pushExitOnce(this.createExitPoint(
                  exitId,
                  callerMethod.id,
                  'sdk',
                  methodName ? `External call: ${objectOrClass}::${methodName}` : `External call: ${objectOrClass}`,
                  `Library call to ${this.identifyPHPLibrary(objectOrClass)}`,
                  undefined,
                  undefined,
                  {
                    targetClass: objectOrClass,
                    targetFunction: methodName || objectOrClass,
                    line: i + 1,
                    library: this.identifyPHPLibrary(objectOrClass)
                  }
                ));
            }
          }
        }

        const laravelRoutes = [
          ...Array.from(line.matchAll(/Route::(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g)),
          ...Array.from(line.matchAll(/@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*['"]([^'"]+)['"]/g))
        ];

        for (const route of laravelRoutes) {
          const httpMethod = route[1].toUpperCase();
          const path = route[2];

          const controllerMatch = line.match(/\[([\w\\]+)::class\s*,\s*['"](\w+)['"]/);
          if (controllerMatch) {
            const controllerClass = controllerMatch[1];
            const actionMethod = controllerMatch[2];

            const controllerNode = firstClassByName(controllerClass.split('\\').pop());

            if (controllerNode) {
              const actionNode = firstMethodInClass(controllerNode.id, actionMethod);

              if (actionNode) {
                const endpointEdgeId = `http_endpoint_${actionNode.id}_${httpMethod}_${i}`;
                if (!edgeIds.has(endpointEdgeId)) {
                  pushEdgeOnce(this.createEdge(
                    endpointEdgeId,
                    `entry_${actionNode.id}`,
                    actionNode.id,
                    'exposes',
                    'behavior',
                    {
                      httpMethod,
                      path,
                      framework: 'Laravel'
                    }
                  ));
                }
              }
            }
          }
        }

        const symfonyRoutes = [
          ...Array.from(line.matchAll(/#\[Route\s*\(\s*['"]([^'"]+)['"]\s*,\s*methods:\s*\[['"](\w+)['"]\]/g))
        ];

        for (const route of symfonyRoutes) {
          const path = route[1];
          const httpMethod = route[2].toUpperCase();

          const nextMethodLine = this.findNextMethodDeclaration(lines, i);
          if (nextMethodLine !== -1) {
            const methodAtLine = methodsInFile.find(n => n.source?.line === nextMethodLine + 1);

            if (methodAtLine) {
              const endpointEdgeId = `http_endpoint_${methodAtLine.id}_${httpMethod}_${i}`;
              if (!edgeIds.has(endpointEdgeId)) {
                pushEdgeOnce(this.createEdge(
                  endpointEdgeId,
                  `entry_${methodAtLine.id}`,
                  methodAtLine.id,
                  'exposes',
                  'behavior',
                  {
                    httpMethod,
                    path,
                    framework: 'Symfony'
                  }
                ));
              }
            }
          }
        }
      }
    }

  private findNextMethodDeclaration(lines: string[], startIndex: number): number {
    for (let i = startIndex + 1; i < lines.length; i++) {
      if (this.isMethodDeclaration(lines[i])) {
        return i;
      }
    }
    return -1;
  }

  private isMethodDeclaration(line: string): boolean {
    const trimmed = line.trim();
    const methodPattern = /^(public|private|protected|static|final|abstract)?\s*(function)\s+(\w+)\s*\(/;
    return methodPattern.test(trimmed) && !trimmed.startsWith('//');
  }

  private isExternalLibraryCall(classOrFunc: string, functionName: string, currentNamespace: string): boolean {
    if (isPhpPureBuiltinFunction(functionName) || isPhpPureBuiltinFunction(classOrFunc)) {
      return false;
    }

    const boundaryCrossingBuiltins = [
      'file_get_contents', 'file_put_contents', 'fopen', 'fwrite', 'fread',
      'curl_init', 'curl_exec', 'curl_setopt', 'curl_close', 'fsockopen',
      'stream_socket_client', 'mail', 'exec', 'shell_exec', 'proc_open',
      'passthru', 'system', 'mysqli_connect', 'mysqli_query', 'pg_connect',
      'pg_query', 'socket_create', 'socket_connect', 'ftp_connect',
      'ldap_connect', 'PDO'
    ];

    const frameworkClasses = [
      'DB', 'Cache', 'Session', 'Request', 'Response', 'View', 'Redirect',
      'Auth', 'Hash', 'Validator', 'Mail', 'Queue', 'Event', 'Log',
      'Eloquent', 'Model', 'Controller', 'Middleware', 'PDO', 'mysqli', 'Redis', 'Memcached'
    ];

    return boundaryCrossingBuiltins.includes(functionName) ||
           frameworkClasses.includes(classOrFunc) ||
           classOrFunc.startsWith('\\') ||
           (classOrFunc.includes('\\') && !classOrFunc.startsWith(currentNamespace));
  }

  private identifyPHPLibrary(className: string): string {
    if (className.startsWith('\\PDO') || className === 'PDO') return 'PHP PDO';
    if (className.startsWith('\\mysqli') || className === 'mysqli') return 'MySQLi';
    if (className.startsWith('\\Redis') || className === 'Redis') return 'Redis Extension';
    if (className.startsWith('\\Memcached') || className === 'Memcached') return 'Memcached Extension';

    const frameworkClasses: Record<string, string> = {
      'DB': 'Laravel Database',
      'Eloquent': 'Laravel Eloquent ORM',
      'Auth': 'Laravel Authentication',
      'Cache': 'Framework Cache',
      'Session': 'Framework Session',
      'Request': 'HTTP Request',
      'Response': 'HTTP Response',
      'Controller': 'MVC Controller',
      'Model': 'MVC Model',
      'View': 'MVC View'
    };

    if (frameworkClasses[className]) {
      return frameworkClasses[className];
    }

    const builtinFunctions = [
      'echo', 'print', 'die', 'exit', 'isset', 'empty',
      'json_encode', 'json_decode', 'file_get_contents', 'file_put_contents'
    ];

    if (builtinFunctions.includes(className)) {
      return 'PHP Built-in Function';
    }

    if (className.includes('\\')) {
      const parts = className.split('\\');
      if (parts[0] === 'Illuminate' || parts[1] === 'Illuminate') return 'Laravel Framework';
      if (parts[0] === 'Symfony' || parts[1] === 'Symfony') return 'Symfony Framework';
      if (parts[0] === 'Doctrine' || parts[1] === 'Doctrine') return 'Doctrine ORM';
    }

    return 'External Library';
  }

  private extractDocumentationFromPHPDoc(content: string, lineIndex: number): CASDocumentation | undefined {
    const lines = content.split('\n');
    const docs: CASDocumentation = {
      id: `doc_${lineIndex}`,
      format: 'phpdoc',
      raw: '',
      location: {
        start_line: lineIndex,
        end_line: lineIndex
      }
    };
    let hasContent = false;
    let docBlockText = '';

    for (let i = lineIndex - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line === '/**') {
        break;
      }
      if (line.startsWith('*') || line.startsWith('/**')) {
        const cleanLine = line.replace(/^\/?\*+\s*/, '').replace(/\*\/$/, '');
        if (cleanLine) {
          docBlockText = cleanLine + '\n' + docBlockText;
          hasContent = true;
        }
      } else if (!line.startsWith('//')) {
        break;
      }
    }

    if (hasContent) {
      docs.raw = docBlockText;
      const summaryMatch = docBlockText.match(/^([^@\n]*)/);
      if (summaryMatch && summaryMatch[1].trim()) {
        docs.summary = summaryMatch[1].trim();
      }

      const paramMatches = docBlockText.matchAll(/@param\s+([^\s]+)\s+\$([^\s]+)\s*(.*)/g);
      for (const match of paramMatches) {
        if (!docs.parameters) docs.parameters = [];
        docs.parameters.push({
          name: match[2],
          type: match[1],
          description: match[3]
        });
      }

      const returnMatch = docBlockText.match(/@return\s+([^\s]+)\s*(.*)/);
      if (returnMatch) {
        docs.returns = {
          type: returnMatch[1],
          description: returnMatch[2]
        };
      }

      const throwsMatches = docBlockText.matchAll(/@throws\s+([^\s]+)\s*(.*)/g);
      for (const match of throwsMatches) {
        if (!docs.exceptions) docs.exceptions = [];
        docs.exceptions.push({
          type: match[1],
          description: match[2]
        });
      }

      const sinceMatch = docBlockText.match(/@since\s+(.*)/);
      if (sinceMatch) {
        if (!docs.tags) docs.tags = [];
        docs.tags.push({ tag: 'since', value: sinceMatch[1] });
      }

      const deprecatedMatch = docBlockText.match(/@deprecated\s*(.*)/);
      if (deprecatedMatch) {
        if (!docs.tags) docs.tags = [];
        docs.tags.push({ tag: 'deprecated', value: deprecatedMatch[1] || 'true' });
      }

      return docs;
    }

    return undefined;
  }

  private extractCommentsFromFile(content: string, filePath: string): CASComment[] {
    const comments: CASComment[] = [];
    let commentSeq = 0;
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const singleLineMatch = line.match(/\/\/(.*)$/) || line.match(/#(.*)$/);
      if (singleLineMatch) {
        const text = singleLineMatch[1].trim();
        const style = line.includes('//') ? '//' : '#';
        const purpose = this.classifyCommentPurpose(text);
        comments.push({
          id: `comment_${filePath}_${++commentSeq}`,
          type: 'single-line',
          style,
          text,
          purpose,
          location: {
            file: filePath,
            line: i + 1,
            relative_to: 'inline'
          },
          markers: this.extractCommentMarkers(text)
        });
      }

      if (line.includes('/*') && !line.includes('/**')) {
        let multiLineText = '';
        let endLine = i;
        let foundEnd = false;

        for (let j = i; j < lines.length; j++) {
          const currentLine = lines[j];
          if (j === i) {
            const startMatch = currentLine.match(/\/\*(.*)/);
            if (startMatch) {
              multiLineText = startMatch[1];
              if (currentLine.includes('*/')) {
                multiLineText = multiLineText.replace(/\*\/.*$/, '').trim();
                foundEnd = true;
                endLine = j;
              }
            }
          } else {
            if (currentLine.includes('*/')) {
              multiLineText += '\n' + currentLine.replace(/\*\/.*$/, '').replace(/^\s*\*/, '').trim();
              foundEnd = true;
              endLine = j;
              break;
            } else {
              multiLineText += '\n' + currentLine.replace(/^\s*\*/, '').trim();
            }
          }
        }

        if (foundEnd) {
          const purpose = this.classifyCommentPurpose(multiLineText);
          comments.push({
            id: `comment_${filePath}_${++commentSeq}`,
            type: 'multi-line',
            style: '/* */',
            text: multiLineText.trim(),
            purpose,
            location: {
              file: filePath,
              line: i + 1,
              end_line: endLine + 1,
              relative_to: 'above'
            },
            markers: this.extractCommentMarkers(multiLineText)
          });
          i = endLine;
        }
      }
    }

    return comments;
  }

  private classifyCommentPurpose(text: string): CASComment['purpose'] {
    const lowerText = text.toLowerCase();

    if (/\b(todo|fixme|hack|warning|note|xxx|optimize|refactor)\b/.test(lowerText)) {
      return 'todo';
    }
    if (/\b(warning|warn|caution|danger|important)\b/.test(lowerText)) {
      return 'warning';
    }
    if (/\b(note|info|tip|hint)\b/.test(lowerText)) {
      return 'note';
    }
    if (/\b(hack|temp|temporary|quick|dirty)\b/.test(lowerText)) {
      return 'hack';
    }

    return 'explanation';
  }

  private extractCommentMarkers(text: string): CASComment['markers'] {
    const markers: CASComment['markers'] = {};
    const lowerText = text.toLowerCase();

    markers.is_todo = /\btodo\b/.test(lowerText);
    markers.is_fixme = /\bfixme\b/.test(lowerText);
    markers.is_hack = /\bhack\b/.test(lowerText);
    markers.is_warning = /\b(warning|warn)\b/.test(lowerText);
    markers.is_note = /\b(note|info)\b/.test(lowerText);
    markers.is_important = /\b(important|critical|urgent)\b/.test(lowerText);
    markers.is_deprecated = /\b(deprecated|obsolete)\b/.test(lowerText);

    return markers;
  }

  private extractTodosFromComments(comments: CASComment[], context: string): CASTodo[] {
    const todos: CASTodo[] = [];
    let todoSeq = 0;

    comments.forEach(comment => {
      if (comment.markers?.is_todo || comment.markers?.is_fixme || comment.markers?.is_hack) {
        const typeMatch = comment.text.match(/\b(TODO|FIXME|HACK|NOTE|WARNING|XXX|OPTIMIZE|REFACTOR)\b/i);
        const type = typeMatch ? typeMatch[0].toUpperCase() as CASTodo['type'] : 'TODO';

        const assigneeMatch = comment.text.match(/\b(?:TODO|FIXME|HACK)\s*\(([^)]+)\)/);
        const assignee = assigneeMatch ? assigneeMatch[1] : undefined;

        const priority = comment.markers?.is_important ? 'high' :
                        comment.markers?.is_fixme ? 'medium' : 'low';

        const category = this.categorizeTodo(comment.text);

        todos.push({
          id: `todo_${comment.location.file}_${comment.location.line}_${++todoSeq}`,
          type,
          text: comment.text,
          priority,
          assignee,
          category,
          location: {
            file: comment.location.file,
            line: comment.location.line,
            context
          },
          metadata: {
            source: 'comment',
            comment_type: comment.type
          }
        });
      }
    });

    return todos;
  }

  private categorizeTodo(text: string): CASTodo['category'] {
    const lowerText = text.toLowerCase();

    if (/\b(fix|bug|error|issue|broken)\b/.test(lowerText)) return 'bug';
    if (/\b(feature|add|implement|new)\b/.test(lowerText)) return 'feature';
    if (/\b(refactor|clean|improve|restructure)\b/.test(lowerText)) return 'refactor';
    if (/\b(performance|optimize|speed|slow)\b/.test(lowerText)) return 'performance';
    if (/\b(security|secure|auth|permission)\b/.test(lowerText)) return 'security';

    return 'general';
  }

  private extractDocumentationFromPhpDoc(docComment?: string): CASDocumentation | undefined {
    if (!docComment) return undefined;

    const cleanDoc = docComment.replace(/\/\*\*|\*\/|\*/g, '').trim();
    if (!cleanDoc) return undefined;

    const lines = cleanDoc.split('\n').map(line => line.trim()).filter(line => line);
    if (lines.length === 0) return undefined;

    const docs: CASDocumentation = {
      type: 'phpdoc',
      raw: cleanDoc,
      location: { start_line: 0, end_line: 0 }
    };

    docs.summary = lines[0];
    docs.description = lines.join('\n');

    // Extract parameters
    const paramMatches = cleanDoc.match(/@param\s+([^\s]+)\s+\$([^\s]+)(?:\s+(.*))?/g);
    if (paramMatches) {
      docs.parameters = paramMatches.map(match => {
        const parts = match.match(/@param\s+([^\s]+)\s+\$([^\s]+)(?:\s+(.*))?/);
        return {
          name: parts?.[2] || '',
          type: parts?.[1] || '',
          description: parts?.[3] || ''
        };
      });
    }

    // Extract return type
    const returnMatch = cleanDoc.match(/@return\s+([^\s]+)(?:\s+(.*))?/);
    if (returnMatch) {
      docs.return_info = {
        type: returnMatch[1],
        description: returnMatch[2] || ''
      };
    }

    // Extract examples
    const exampleMatch = cleanDoc.match(/@example\s*(.*?)(?=@|$)/s);
    if (exampleMatch) {
      docs.examples = [{ code: exampleMatch[1].trim(), language: 'php' }];
    }

    return docs;
  }

  private detectImplementationStatus(methodInfo: PHPMethod, methodBody: string[]): CASImplementationStatus {
    const bodyText = methodBody.join('\n').toLowerCase();

    const indicators = {
      has_not_implemented_exceptions: bodyText.includes('throw new exception') || bodyText.includes('throw new notimplementedexception'),
      has_deprecated_markers: !!methodInfo.docComment?.includes('@deprecated'),
      has_todo_markers: bodyText.includes('todo') || bodyText.includes('fixme'),
      has_stub_returns: methodBody.length <= 2 && bodyText.includes('return'),
      has_empty_body: methodBody.length <= 1 || bodyText.trim() === '{}' || bodyText.trim() === '{ }',
      has_placeholder_code: bodyText.includes('echo "todo"') || bodyText.includes('var_dump("todo")'),
      has_hardcoded_values: false,
      has_commented_out_code: false
    };

    let status: CASImplementationStatus['status'] = 'complete';
    if (indicators.has_not_implemented_exceptions) {
      status = 'not-implemented';
    } else if (indicators.has_deprecated_markers) {
      status = 'deprecated';
    } else if (indicators.has_stub_returns || indicators.has_empty_body) {
      status = 'stub';
    } else if (indicators.has_todo_markers || indicators.has_placeholder_code) {
      status = 'partial';
    }

    return {
      status,
      indicators,
      completeness: status === 'complete' ? { estimated_percentage: 100 } :
                   status === 'partial' ? { estimated_percentage: 60 } :
                   status === 'stub' ? { estimated_percentage: 10 } :
                   { estimated_percentage: 0 }
    };
  }

  protected sanitizeId(name: string): string {
    return name.replace(/[^a-zA-Z0-9]/g, '_');
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

  protected getCapabilities(): string[] {
    return [
      'class-analysis',
      'interface-detection',
      'trait-analysis',
      'method-mapping',
      'namespace-organization',
      'inheritance-tracking',
      'composer-dependency-analysis',
      'framework-detection'
    ];
  }
}
