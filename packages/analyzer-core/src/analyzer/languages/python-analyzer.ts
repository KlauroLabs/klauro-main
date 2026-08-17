import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  CASDocumentation, CASComment, CASTodo, CASImplementationStatus, FileAnalysisResult
} from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import { detectSyntaxDegradation } from '../core/syntax-degradation';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';
import { addPythonCallNodes, buildPythonCallIndex, selectPythonCallTarget, selectPythonSelfCallTarget, type PythonCallIndex } from './python-call-index';
import { replaceArrayContents } from '../core/bulk-array-ops';

interface PythonClass {
  name: string;
  moduleName: string;
  filePath: string;
  baseClasses: string[];
  methods: PythonMethod[];
  attributes: PythonAttribute[];
  decorators: string[];
  docstring?: string;
  lineStart: number;
  lineEnd: number;
  isAbstract: boolean;
  documentation?: CASDocumentation;
  comments?: CASComment[];
  todos?: CASTodo[];
  implementationStatus?: CASImplementationStatus;
}

interface PythonMethod {
  name: string;
  parameters: PythonParameter[];
  decorators: string[];
  docstring?: string;
  returnAnnotation?: string;
  lineStart: number;
  lineEnd: number;
  isClassMethod: boolean;
  isStaticMethod: boolean;
  isProperty: boolean;
  isPrivate: boolean;
  isAbstract: boolean;
  isAsync: boolean;
  documentation?: CASDocumentation;
  comments?: CASComment[];
  todos?: CASTodo[];
  implementationStatus?: CASImplementationStatus;
}

interface PythonFunction {
  name: string;
  parameters: PythonParameter[];
  decorators: string[];
  docstring?: string;
  returnAnnotation?: string;
  lineStart: number;
  lineEnd: number;
  isAsync: boolean;
  isPrivate: boolean;
  documentation?: CASDocumentation;
  comments?: CASComment[];
  todos?: CASTodo[];
  implementationStatus?: CASImplementationStatus;
}

interface PythonParameter {
  name: string;
  annotation?: string;
  defaultValue?: string;
  isVarArgs: boolean;
  isKwArgs: boolean;
}

interface PythonAttribute {
  name: string;
  annotation?: string;
  value?: string;
  lineNumber: number;
  isPrivate: boolean;
  isClassAttribute: boolean;
}

interface PythonImport {
  module: string;
  alias?: string;
  fromImport?: string;
  lineNumber: number;
  isRelative: boolean;
}

interface PythonVariable {
  name: string;
  annotation?: string;
  value?: string;
  lineNumber: number;
  scope: 'global' | 'local' | 'class';
}

export class PythonAnalyzer extends BaseAnalyzer {
  private djangoFrameworkDetected = false;
  private flaskFrameworkDetected = false;
  private fastApiFrameworkDetected = false;
  private poetryProject = false;
  private pipenvProject = false;

  constructor() {
    super(
      'python',
      'Python Language Analyzer',
      '1.0.0',
      'language'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const pythonFiles = await glob(['**/*.py'], {
        cwd: projectPath,
        ignore: [...this.getIgnorePatterns({ projectPath }), '**/src/analyzer/**', '**/analyzer/**', '**/analyzers/**'],
        nodir: true
      });

      const configFiles = await glob(['requirements.txt', 'setup.py', 'pyproject.toml', 'Pipfile'], {
        cwd: projectPath,
        ignore: [...this.getIgnorePatterns({ projectPath }), '**/src/analyzer/**', '**/analyzer/**', '**/analyzers/**'],
        nodir: true
      });

      return pythonFiles.length > 0 || configFiles.length > 0;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const ignorePatterns = this.getIgnorePatterns({ projectPath });
    const files = await glob(['**/*.py'], {
      cwd: projectPath,
      ignore: [...ignorePatterns, '**/venv/**', '**/.venv/**', '**/env/**', '**/__pycache__/**'],
      nodir: true
    });
    return files.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const modules = new Map<string, string[]>();
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);
    const retainedNodes = (context.existingAnalysis || [])
      .flatMap(contribution => contribution.nodes || [])
      .filter(node =>
        node.source?.file !== context.relativePath &&
        (node.primaryAnalyzer === this.analyzerId || node.analyzers?.includes(this.analyzerId))
      );
    const callIndex = buildPythonCallIndex(retainedNodes, edges, exitPoints);

    await this.detectProjectType(context.projectPath);
    await this.analyzePythonFile(
      context.filePath,
      context.relativePath,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      modules,
      retainedNodes,
      callIndex,
    );
    this.detectFrameworkPatterns(nodes, edges, entryPoints);
    const projectNodes = [...retainedNodes, ...nodes];
    const currentNodeIds = new Set(nodes.map(node => node.id));
    const projectEdges = [...edges];
    const projectEntryPoints = [...entryPoints];
    const projectExitPoints = [...exitPoints];
    this.buildInheritanceRelationships(projectNodes, projectEdges);
    this.buildCallGraph(projectNodes, projectEdges, projectEntryPoints, projectExitPoints);
    replaceArrayContents(edges, projectEdges.filter(edge => currentNodeIds.has(edge.source)));
    replaceArrayContents(entryPoints, projectEntryPoints.filter(entryPoint => currentNodeIds.has(entryPoint.source_node)));
    replaceArrayContents(exitPoints, projectExitPoints.filter(exitPoint => currentNodeIds.has(exitPoint.source_node)));
    this.applyTestFileBoundary(nodes);

    const imports = this.extractImports(content).map(imp => imp.module);
    const exports = nodes
      .filter(node => ['class', 'function', 'method', 'variable'].includes(node.type))
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
      await this.detectProjectType(context.projectPath);
      await this.extractDependencies(context.projectPath, libraries);

      const ignorePatterns = this.getIgnorePatterns(context);
      const pythonIgnorePatterns = [...ignorePatterns, '**/venv/**', '**/.venv/**', '**/env/**', '**/__pycache__/**'];
      const pythonFiles = this.capAndPrioritizeSourceFiles(await glob(['**/*.py'], {
        cwd: context.projectPath,
        ignore: pythonIgnorePatterns,
        nodir: true
      }), 'Python files');
      pythonFiles.sort();

      const modules = new Map<string, string[]>();
      const callIndex = buildPythonCallIndex([], edges, exitPoints);

      for (const file of pythonFiles) {
        const fullPath = `${context.projectPath}/${file}`;
        await this.analyzePythonFile(fullPath, file, nodes, edges, entryPoints, exitPoints, modules, [], callIndex);
      }

      this.buildModuleHierarchy(modules, nodes, edges);
      this.detectFrameworkPatterns(nodes, edges, entryPoints);
      this.buildInheritanceRelationships(nodes, edges);
      if (this.shouldBuildExpensiveLanguageCallGraph(pythonFiles.length)) {
        this.buildCallGraph(nodes, edges, entryPoints, exitPoints);
      } else {
        this.addAnalysisWarning(
          `Python cross-file call graph deferred for ${process.env.KLAURO_ANALYSIS_FOCUS || 'default'} focus after ${pythonFiles.length} prioritized files; run deep-context/full analysis for exhaustive Python call edges`
        );
      }
      this.applyTestFileBoundary(nodes);

      const warnings = this.collectAnalysisWarnings();
      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        ...(warnings.length > 0 ? { warnings } : {}),
        framework_specific: {
          language: 'python',
          djangoFramework: this.djangoFrameworkDetected,
          flaskFramework: this.flaskFrameworkDetected,
          fastApiFramework: this.fastApiFrameworkDetected,
          packageManager: this.poetryProject ? 'poetry' : this.pipenvProject ? 'pipenv' : 'pip',
          libraries,
          filesAnalyzed: pythonFiles.length,
          modulesFound: modules.size
        }
      });

    } catch (error) {
      throw new AnalyzerError(
        `Python analysis failed: ${(error as Error).message}`,
        'PYTHON_ANALYSIS_ERROR'
      );
    }
  }

  private shouldBuildExpensiveLanguageCallGraph(fileCount: number): boolean {
    const focus = process.env.KLAURO_ANALYSIS_FOCUS;
    if (focus === 'agent-fast' || focus === 'ui-overview') return fileCount <= 900;
    if (focus === 'deep-context') return fileCount <= 2500;
    return true;
  }

  private async detectProjectType(projectPath: string): Promise<void> {
    const pyprojectPath = `${projectPath}/pyproject.toml`;
    const pipfilePath = `${projectPath}/Pipfile`;
    const requirementsPath = `${projectPath}/requirements.txt`;

    this.poetryProject = await fs.pathExists(pyprojectPath);
    this.pipenvProject = await fs.pathExists(pipfilePath);

    if (this.poetryProject) {
      const pyprojectContent = await fs.readFile(pyprojectPath, 'utf-8');
      this.detectFrameworks(pyprojectContent);
    }

    if (this.pipenvProject) {
      const pipfileContent = await fs.readFile(pipfilePath, 'utf-8');
      this.detectFrameworks(pipfileContent);
    }

    if (await fs.pathExists(requirementsPath)) {
      const requirementsContent = await fs.readFile(requirementsPath, 'utf-8');
      this.detectFrameworks(requirementsContent);
    }
  }

  private detectFrameworks(content: string): void {
    this.djangoFrameworkDetected = this.djangoFrameworkDetected ||
      content.includes('django') || content.includes('Django');

    this.flaskFrameworkDetected = this.flaskFrameworkDetected ||
      content.includes('flask') || content.includes('Flask');

    this.fastApiFrameworkDetected = this.fastApiFrameworkDetected ||
      content.includes('fastapi') || content.includes('FastAPI');
  }

  private async extractDependencies(projectPath: string, libraries: any[]): Promise<void> {
    const requirementsPath = `${projectPath}/requirements.txt`;
    const pyprojectPath = `${projectPath}/pyproject.toml`;
    const pipfilePath = `${projectPath}/Pipfile`;

    if (await fs.pathExists(requirementsPath)) {
      await this.extractRequirementsDependencies(requirementsPath, libraries);
    }

    if (await fs.pathExists(pyprojectPath)) {
      await this.extractPyprojectDependencies(pyprojectPath, libraries);
    }

    if (await fs.pathExists(pipfilePath)) {
      await this.extractPipfileDependencies(pipfilePath, libraries);
    }
  }

  private async extractRequirementsDependencies(requirementsPath: string, libraries: any[]): Promise<void> {
    try {
      const content = await fs.readFile(requirementsPath, 'utf-8');
      const lines = content.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const match = trimmed.match(/^([a-zA-Z0-9\-_]+)([>=<~!]+)?([0-9.]*)?/);
          if (match) {
            libraries.push({
              name: match[1],
              version: match[3] || 'unknown',
              type: 'pip_package',
              source: 'requirements.txt',
              metadata: {
                constraint: match[2] || '==',
                isProduction: true
              }
            });
          }
        }
      }
    } catch (error) {
      console.warn('Failed to parse requirements.txt:', error);
    }
  }

  private async extractPyprojectDependencies(pyprojectPath: string, libraries: any[]): Promise<void> {
    try {
      const content = await fs.readFile(pyprojectPath, 'utf-8');
      const dependencySection = content.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\[|$)/);

      if (dependencySection) {
        const lines = dependencySection[1].split('\n');
        for (const line of lines) {
          const match = line.match(/^([a-zA-Z0-9\-_]+)\s*=\s*["']([^"']+)["']/);
          if (match && match[1] !== 'python') {
            libraries.push({
              name: match[1],
              version: match[2],
              type: 'poetry_package',
              source: 'pyproject.toml',
              metadata: {
                isProduction: true
              }
            });
          }
        }
      }
    } catch (error) {
      console.warn('Failed to parse pyproject.toml:', error);
    }
  }

  private async extractPipfileDependencies(pipfilePath: string, libraries: any[]): Promise<void> {
    try {
      const content = await fs.readFile(pipfilePath, 'utf-8');
      const packagesSection = content.match(/\[packages\]([\s\S]*?)(?=\[|$)/);

      if (packagesSection) {
        const lines = packagesSection[1].split('\n');
        for (const line of lines) {
          const match = line.match(/^([a-zA-Z0-9\-_]+)\s*=\s*["']([^"']+)["']/);
          if (match) {
            libraries.push({
              name: match[1],
              version: match[2],
              type: 'pipenv_package',
              source: 'Pipfile',
              metadata: {
                isProduction: true
              }
            });
          }
        }
      }
    } catch (error) {
      console.warn('Failed to parse Pipfile:', error);
    }
  }

  private async analyzePythonFile(
    fullPath: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[],
    exitPoints: any[],
    modules: Map<string, string[]>,
    retainedNodes: CASNode[] = [],
    callIndex?: PythonCallIndex,
  ): Promise<void> {
    try {
      const nodeStart = nodes.length;
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');

      const moduleName = this.getModuleName(relativePath);
      const imports = this.extractImports(content);
      const classes = this.extractClasses(content, relativePath);
      const functions = this.extractFunctions(content, relativePath);
      const variables = this.extractGlobalVariables(content);
      const degradation = detectSyntaxDegradation({
        relativePath,
        content,
        language: 'python',
        extractedNodeCount: classes.length + functions.length,
      });
      if (degradation) this.addAnalysisWarning(degradation);
      const fileComments = this.extractCommentsFromFile(content, relativePath);
      const fileTodos = this.extractTodosFromComments(fileComments, relativePath);

      if (!modules.has(moduleName)) {
        modules.set(moduleName, []);
      }
      modules.get(moduleName)!.push(relativePath);

      const fileId = `file_${this.sanitizeId(relativePath)}`;
      const fileNode = this.createNodeBuilder(fileId, relativePath.split('/').pop() || 'unknown.py', 'file')
        .withLevel(1, this.getLevelName(1))
        .withSource({ file: relativePath, line: 1, end_line: lines.length })
        .withMetadata({
          framework: this.analyzerName.toLowerCase().replace(' analyzer', ''),
          attributes: {
            moduleName,
            imports: imports.map(i => i.module),
            classCount: classes.length,
            functionCount: functions.length,
            variableCount: variables.length
          }
        })
        .withComments(fileComments)
        .withTodos(fileTodos)
        .withAnalyzers([this.analyzerId], this.analyzerId)
        .withTags([`analyzer:${this.analyzerId}`])
        .build();
      nodes.push(fileNode);

      for (const imp of imports) {
        const importId = `import_${fileId}_${this.sanitizeId(imp.module)}`;
        nodes.push(this.createNode(
          importId,
          imp.alias || imp.fromImport || imp.module,
          'import',
          2,
          relativePath,
          imp.lineNumber,
          imp.lineNumber,
          {
            module: imp.module,
            alias: imp.alias,
            fromImport: imp.fromImport,
            isRelative: imp.isRelative
          }
        ));

        edges.push(this.createEdge(
          `${fileId}_imports_${importId}`,
          fileId,
          importId,
          'imports'
        ));

        if (!imp.isRelative && !this.isStandardLibrary(imp.module)) {
          exitPoints.push({
            id: `exit_${importId}`,
            name: `External module: ${imp.module}`,
            type: 'external_import',
            source_node: importId,
            metadata: { module: imp.module }
          });
        }
      }

      for (const cls of classes) {
        await this.processPythonClass(cls, fileId, relativePath, nodes, edges, entryPoints);
      }

      for (const func of functions) {
        await this.processPythonFunction(func, fileId, relativePath, nodes, edges, entryPoints);
      }

      if (callIndex) addPythonCallNodes(callIndex, nodes.slice(nodeStart));
      this.extractFunctionCalls(
        content,
        relativePath,
        classes,
        functions,
        retainedNodes.length > 0 ? [...retainedNodes, ...nodes] : nodes,
        edges,
        exitPoints,
        callIndex,
      );

      for (const variable of variables) {
        const variableId = `variable_${fileId}_${this.sanitizeId(variable.name)}`;
        nodes.push(this.createNode(
          variableId,
          variable.name,
          'variable',
          3,
          relativePath,
          variable.lineNumber,
          variable.lineNumber,
          {
            annotation: variable.annotation,
            value: variable.value,
            scope: variable.scope
          }
        ));

        edges.push(this.createEdge(
          `${fileId}_contains_${variableId}`,
          fileId,
          variableId,
          'contains'
        ));
      }

    } catch (error) {
      console.warn(`Failed to analyze Python file ${relativePath}:`, error);
    }
  }

  private async processPythonClass(
    cls: PythonClass,
    fileId: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const classId = `class_${this.sanitizeId(cls.moduleName)}_${this.sanitizeId(cls.name)}`;

    const classNode = this.createNodeBuilder(classId, cls.name, 'class')
      .withLevel(2, this.getLevelName(2))
      .withSource({ file: relativePath, line: cls.lineStart, end_line: cls.lineEnd })
      .withMetadata({
        framework: this.analyzerName.toLowerCase().replace(' analyzer', ''),
        attributes: {
          moduleName: cls.moduleName,
          baseClasses: cls.baseClasses,
          decorators: cls.decorators,
          docstring: cls.docstring,
          methodCount: cls.methods.length,
          attributeCount: cls.attributes.length,
          isAbstract: cls.isAbstract
        }
      })
      .withDocumentation(cls.documentation)
      .withComments(cls.comments)
      .withTodos(cls.todos)
      .withImplementationStatus(cls.implementationStatus)
      .withAnalyzers([this.analyzerId], this.analyzerId)
      .withTags([`analyzer:${this.analyzerId}`])
      .build();
    nodes.push(classNode);

    edges.push(this.createEdge(
      `${fileId}_contains_${classId}`,
      fileId,
      classId,
      'contains'
    ));

    for (const method of cls.methods) {
      const methodId = `method_${classId}_${this.sanitizeId(method.name)}_${method.lineStart}`;
      const methodNode = this.createNodeBuilder(methodId, method.name, 'method')
        .withLevel(4, this.getLevelName(4))
        .withParent(classId)
        .withSource({ file: relativePath, line: method.lineStart, end_line: method.lineEnd })
        .withMetadata({
          framework: this.analyzerName.toLowerCase().replace(' analyzer', ''),
          attributes: {
            parameters: method.parameters,
            decorators: method.decorators,
            docstring: method.docstring,
            returnAnnotation: method.returnAnnotation,
            isClassMethod: method.isClassMethod,
            isStaticMethod: method.isStaticMethod,
            isProperty: method.isProperty,
            isPrivate: method.isPrivate,
            isAbstract: method.isAbstract,
            isAsync: method.isAsync
          }
        })
        .withDocumentation(method.documentation)
        .withComments(method.comments)
        .withTodos(method.todos)
        .withImplementationStatus(method.implementationStatus)
        .withAnalyzers([this.analyzerId], this.analyzerId)
        .withTags([`analyzer:${this.analyzerId}`])
        .build();
      nodes.push(methodNode);

      edges.push(this.createEdge(
        `${classId}_has_method_${methodId}`,
        classId,
        methodId,
        'has_method'
      ));
    }

    for (const attr of cls.attributes) {
      const attrId = `attribute_${classId}_${this.sanitizeId(attr.name)}`;
      nodes.push(this.createNode(
        attrId,
        attr.name,
        'attribute',
        4,
        relativePath,
        attr.lineNumber,
        attr.lineNumber,
        {
          annotation: attr.annotation,
          value: attr.value,
          isPrivate: attr.isPrivate,
          isClassAttribute: attr.isClassAttribute
        }
      ));

      edges.push(this.createEdge(
        `${classId}_has_attribute_${attrId}`,
        classId,
        attrId,
        'has_attribute'
      ));
    }
  }

  private async processPythonFunction(
    func: PythonFunction,
    fileId: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const functionId = `function_${fileId}_${this.sanitizeId(func.name)}_${func.lineStart}`;

    const functionNode = this.createNodeBuilder(functionId, func.name, 'function')
      .withLevel(3, this.getLevelName(3))
      .withSource({ file: relativePath, line: func.lineStart, end_line: func.lineEnd })
      .withMetadata({
        framework: this.analyzerName.toLowerCase().replace(' analyzer', ''),
        attributes: {
          parameters: func.parameters,
          decorators: func.decorators,
          docstring: func.docstring,
          returnAnnotation: func.returnAnnotation,
          isAsync: func.isAsync,
          isPrivate: func.isPrivate
        }
      })
      .withDocumentation(func.documentation)
      .withComments(func.comments)
      .withTodos(func.todos)
      .withImplementationStatus(func.implementationStatus)
      .withAnalyzers([this.analyzerId], this.analyzerId)
      .withTags([`analyzer:${this.analyzerId}`])
      .build();
    nodes.push(functionNode);

    edges.push(this.createEdge(
      `${fileId}_contains_${functionId}`,
      fileId,
      functionId,
      'contains'
    ));
  }

  private extractImports(content: string): PythonImport[] {
    const imports: PythonImport[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      const fromImportMatch = line.match(/^from\s+([.\w]+)\s+import\s+(.+)/);
      if (fromImportMatch) {
        const module = fromImportMatch[1];
        const importItems = fromImportMatch[2].split(',').map(s => s.trim());

        for (const item of importItems) {
          const aliasMatch = item.match(/^(\w+)(?:\s+as\s+(\w+))?/);
          if (aliasMatch) {
            imports.push({
              module,
              fromImport: aliasMatch[1],
              alias: aliasMatch[2],
              lineNumber: i + 1,
              isRelative: module.startsWith('.')
            });
          }
        }
        continue;
      }

      const importMatch = line.match(/^import\s+(.+)/);
      if (importMatch) {
        const importItems = importMatch[1].split(',').map(s => s.trim());

        for (const item of importItems) {
          const aliasMatch = item.match(/^([.\w]+)(?:\s+as\s+(\w+))?/);
          if (aliasMatch) {
            imports.push({
              module: aliasMatch[1],
              alias: aliasMatch[2],
              lineNumber: i + 1,
              isRelative: aliasMatch[1].startsWith('.')
            });
          }
        }
      }
    }

    return imports;
  }

  private extractClasses(content: string, filePath: string): PythonClass[] {
    const classes: PythonClass[] = [];
    const lines = content.split('\n');
    const moduleName = this.getModuleName(filePath);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.trim().startsWith('class ')) {
        let classMatch = line.match(/class\s+(\w+)(?:\(([^)]*)\))?:/);
        let signatureEndIndex = i;
        if (!classMatch) {

          const collected = this.collectLogicalStatement(lines, i);
          classMatch = collected.text.match(/class\s+(\w+)(?:\(([^)]*)\))?:/);
          if (classMatch) signatureEndIndex = collected.endIndex;
        }
        if (classMatch) {
          const className = classMatch[1];
          const baseClasses = classMatch[2]
            ? classMatch[2].split(',').map(s => s.trim()).filter(Boolean)
            : [];

          const decorators = this.extractDecorators(lines, i);
          const classStartLine = signatureEndIndex + 1;
          const classEndLine = this.findBlockEnd(lines, i);

          const methods = this.extractMethods(lines, signatureEndIndex, classEndLine);
          const attributes = this.extractClassAttributes(lines, signatureEndIndex, classEndLine);
          const docstring = this.extractDocstring(lines, signatureEndIndex + 1);
          const documentation = this.extractDocumentationFromDocstring(docstring || '', 'class');
          const classContent = lines.slice(i, classEndLine).join('\n');
          const classComments = this.extractCommentsFromContent(classContent, filePath, classStartLine);
          const classTodos = this.extractTodosFromComments(classComments, className);
          const implementationStatus = this.detectImplementationStatus(
            classContent,
            lines.slice(i, classEndLine),
            classStartLine,
            classEndLine
          );

          const isAbstract = decorators.some(d => d.includes('abc.abstractmethod')) ||
                           baseClasses.some(b => b.includes('ABC'));

          classes.push({
            name: className,
            moduleName,
            filePath,
            baseClasses,
            methods,
            attributes,
            decorators,
            docstring,
            lineStart: classStartLine,
            lineEnd: classEndLine,
            isAbstract,
            documentation,
            comments: classComments,
            todos: classTodos,
            implementationStatus
          });
        }
      }
    }

    return classes;
  }

  private extractFunctions(content: string, filePath: string): PythonFunction[] {
    const functions: PythonFunction[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.trim().startsWith('def ') || line.trim().startsWith('async def ')) {
        let funcMatch = line.match(/(async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?:/);
        let signatureEndIndex = i;
        if (!funcMatch) {

          const collected = this.collectLogicalStatement(lines, i);
          funcMatch = collected.text.match(/(async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?:/);
          if (funcMatch) signatureEndIndex = collected.endIndex;
        }
        if (funcMatch) {
          const isAsync = !!funcMatch[1];
          const functionName = funcMatch[2];
          const paramString = funcMatch[3];
          const returnAnnotation = funcMatch[4]?.trim();

          if (!this.isInsideClass(lines, i)) {
            const decorators = this.extractDecorators(lines, i);
            const functionStartLine = signatureEndIndex + 1;
            const functionEndLine = this.findBlockEnd(lines, i);

            const parameters = this.extractParameters(paramString);
            const docstring = this.extractDocstring(lines, signatureEndIndex + 1);
            const documentation = this.extractDocumentationFromDocstring(docstring || '', 'function');
            const functionContent = lines.slice(i, functionEndLine).join('\n');
            const functionComments = this.extractCommentsFromContent(functionContent, filePath, functionStartLine);
            const functionTodos = this.extractTodosFromComments(functionComments, functionName);
            const implementationStatus = this.detectImplementationStatus(
              functionContent,
              lines.slice(i, functionEndLine),
              functionStartLine,
              functionEndLine
            );

            functions.push({
              name: functionName,
              parameters,
              decorators,
              docstring,
              returnAnnotation,
              lineStart: functionStartLine,
              lineEnd: functionEndLine,
              isAsync,
              isPrivate: functionName.startsWith('_'),
              documentation,
              comments: functionComments,
              todos: functionTodos,
              implementationStatus
            });
          }
        }
      }
    }

    return functions;
  }

  private extractMethods(lines: string[], classStart: number, classEnd: number): PythonMethod[] {
    const methods: PythonMethod[] = [];

    for (let i = classStart + 1; i < classEnd; i++) {
      const line = lines[i];
      const indent = line.length - line.trimStart().length;

      if (indent > 0 && (line.trim().startsWith('def ') || line.trim().startsWith('async def '))) {
        let methodMatch = line.match(/(async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?:/);
        let signatureEndIndex = i;
        if (!methodMatch) {
          const collected = this.collectLogicalStatement(lines, i);
          methodMatch = collected.text.match(/(async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?:/);
          if (methodMatch) signatureEndIndex = collected.endIndex;
        }
        if (methodMatch) {
          const isAsync = !!methodMatch[1];
          const methodName = methodMatch[2];
          const paramString = methodMatch[3];
          const returnAnnotation = methodMatch[4]?.trim();

          const decorators = this.extractDecorators(lines, i);
          const methodStartLine = signatureEndIndex + 1;
          const methodEndLine = this.findBlockEnd(lines, i);

          const parameters = this.extractParameters(paramString);
          const docstring = this.extractDocstring(lines, signatureEndIndex + 1);
          const documentation = this.extractDocumentationFromDocstring(docstring || '', 'method');
          const methodContent = lines.slice(i, methodEndLine).join('\n');
          const methodComments = this.extractCommentsFromContent(methodContent, '', methodStartLine);
          const methodTodos = this.extractTodosFromComments(methodComments, methodName);
          const implementationStatus = this.detectImplementationStatus(
            methodContent,
            lines.slice(i, methodEndLine),
            methodStartLine,
            methodEndLine
          );

          const isClassMethod = decorators.includes('classmethod');
          const isStaticMethod = decorators.includes('staticmethod');
          const isProperty = decorators.includes('property');
          const isPrivate = methodName.startsWith('_');
          const isAbstract = decorators.some(d => d.includes('abstractmethod'));

          methods.push({
            name: methodName,
            parameters,
            decorators,
            docstring,
            returnAnnotation,
            lineStart: methodStartLine,
            lineEnd: methodEndLine,
            isClassMethod,
            isStaticMethod,
            isProperty,
            isPrivate,
            isAbstract,
            isAsync,
            documentation,
            comments: methodComments,
            todos: methodTodos,
            implementationStatus
          });
        }
      }
    }

    return methods;
  }

  private extractClassAttributes(lines: string[], classStart: number, classEnd: number): PythonAttribute[] {
    const attributes: PythonAttribute[] = [];

    for (let i = classStart + 1; i < classEnd; i++) {
      const line = lines[i].trim();

      if (line && !line.startsWith('def ') && !line.startsWith('class ') && !line.startsWith('#')) {
        const attrMatch = line.match(/^(\w+)(?:\s*:\s*([^=]+))?\s*(?:=\s*(.+))?/);
        if (attrMatch) {
          const attrName = attrMatch[1];
          const annotation = attrMatch[2]?.trim();
          const value = attrMatch[3]?.trim();

          if (!['if', 'for', 'while', 'try', 'with', 'return', 'yield'].includes(attrName)) {
            attributes.push({
              name: attrName,
              annotation,
              value,
              lineNumber: i + 1,
              isPrivate: attrName.startsWith('_'),
              isClassAttribute: true
            });
          }
        }
      }
    }

    return attributes;
  }

  private extractGlobalVariables(content: string): PythonVariable[] {
    const variables: PythonVariable[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.trim() && !line.trim().startsWith('#') && line.length === line.trimStart().length) {
        const varMatch = line.match(/^(\w+)(?:\s*:\s*([^=]+))?\s*=\s*(.+)/);
        if (varMatch && !this.isInsideClassOrFunction(lines, i)) {
          const varName = varMatch[1];
          const annotation = varMatch[2]?.trim();
          const value = varMatch[3]?.trim();

          if (!['if', 'for', 'while', 'try', 'with', 'class', 'def'].includes(varName)) {
            variables.push({
              name: varName,
              annotation,
              value,
              lineNumber: i + 1,
              scope: 'global'
            });
          }
        }
      }
    }

    return variables;
  }

  private extractParameters(paramString: string): PythonParameter[] {
    const parameters: PythonParameter[] = [];

    if (!paramString.trim()) {
      return parameters;
    }

    const params = this.splitParameters(paramString);

    for (const param of params) {
      const trimmed = param.trim();

      if (trimmed.startsWith('**')) {
        const name = trimmed.substring(2);
        parameters.push({
          name,
          isVarArgs: false,
          isKwArgs: true
        });
      } else if (trimmed.startsWith('*')) {
        const name = trimmed.substring(1);
        parameters.push({
          name,
          isVarArgs: true,
          isKwArgs: false
        });
      } else {
        const paramMatch = trimmed.match(/^(\w+)(?:\s*:\s*([^=]+))?(?:\s*=\s*(.+))?$/);
        if (paramMatch) {
          parameters.push({
            name: paramMatch[1],
            annotation: paramMatch[2]?.trim(),
            defaultValue: paramMatch[3]?.trim(),
            isVarArgs: false,
            isKwArgs: false
          });
        }
      }
    }

    return parameters;
  }

  private splitParameters(paramString: string): string[] {
    const params: string[] = [];
    let current = '';
    let parenCount = 0;
    let bracketCount = 0;
    let braceCount = 0;

    for (const char of paramString) {
      if (char === '(') parenCount++;
      else if (char === ')') parenCount--;
      else if (char === '[') bracketCount++;
      else if (char === ']') bracketCount--;
      else if (char === '{') braceCount++;
      else if (char === '}') braceCount--;
      else if (char === ',' && parenCount === 0 && bracketCount === 0 && braceCount === 0) {
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

  private extractDecorators(lines: string[], lineIndex: number): string[] {
    const decorators: string[] = [];

    for (let i = lineIndex - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('@')) {
        const decoratorMatch = line.match(/@([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/);
        if (decoratorMatch) {
          decorators.unshift(decoratorMatch[1]);
        }
      } else if (line && !line.startsWith('#')) {
        break;
      }
    }

    return decorators;
  }

  private extractDocstring(lines: string[], startLine: number): string | undefined {
    if (startLine >= lines.length) return undefined;

    const line = lines[startLine].trim();

    if (line.startsWith('"""') || line.startsWith("'''")) {
      const quote = line.startsWith('"""') ? '"""' : "'''";

      if (line.endsWith(quote) && line.length > 6) {
        return line.substring(3, line.length - 3);
      }

      let docstring = line.substring(3);
      for (let i = startLine + 1; i < lines.length; i++) {
        const currentLine = lines[i];
        if (currentLine.trim().endsWith(quote)) {
          docstring += '\n' + currentLine.substring(0, currentLine.lastIndexOf(quote));
          break;
        }
        docstring += '\n' + currentLine;
      }

      return docstring.trim();
    }

    return undefined;
  }

  private collectLogicalStatement(
    lines: string[],
    startIndex: number,
    maxLines = 60
  ): { text: string; endIndex: number } {
    let depth = 0;
    let text = '';
    let endIndex = startIndex;

    for (let i = startIndex; i < lines.length && i - startIndex < maxLines; i++) {
      const line = lines[i];
      text += i === startIndex ? line : ` ${line.trim()}`;

      for (const character of line) {
        if (character === '(') depth += 1;
        else if (character === ')') depth -= 1;
      }

      endIndex = i;
      if (depth <= 0 && /:\s*(#.*)?$/.test(line.trimEnd())) {
        break;
      }
    }

    return { text, endIndex };
  }

  private findBlockEnd(lines: string[], startIndex: number): number {
    const startIndent = lines[startIndex].length - lines[startIndex].trimStart().length;

    for (let i = startIndex + 1; i < lines.length; i++) {
      const line = lines[i];

      if (line.trim()) {
        const indent = line.length - line.trimStart().length;
        if (indent <= startIndent) {
          return i;
        }
      }
    }

    return lines.length;
  }

  private isInsideClass(lines: string[], lineIndex: number): boolean {
    const ownIndent = lines[lineIndex].length - lines[lineIndex].trimStart().length;
    if (ownIndent === 0) {

      return false;
    }

    let minIndentSeen = ownIndent;
    for (let i = lineIndex - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      const indent = line.length - line.trimStart().length;

      if (indent < minIndentSeen) {
        if (line.trim().startsWith('class ')) {
          return true;
        }
        minIndentSeen = indent;
        if (indent === 0) break;
      }
    }
    return false;
  }

  private isInsideClassOrFunction(lines: string[], lineIndex: number): boolean {
    const ownIndent = lines[lineIndex].length - lines[lineIndex].trimStart().length;
    if (ownIndent === 0) {
      return false;
    }

    let minIndentSeen = ownIndent;
    for (let i = lineIndex - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      const indent = line.length - line.trimStart().length;

      if (indent < minIndentSeen) {
        const trimmed = line.trim();
        if (trimmed.startsWith('class ') || trimmed.startsWith('def ') || trimmed.startsWith('async def ')) {
          return true;
        }
        minIndentSeen = indent;
        if (indent === 0) break;
      }
    }
    return false;
  }

  private getModuleName(filePath: string): string {
    return filePath.replace(/\.py$/, '').replace(/\//g, '.');
  }

  private isStandardLibrary(module: string): boolean {
    const standardLibModules = [
      'os', 'sys', 'json', 'urllib', 'http', 'datetime', 'time', 'math', 'random',
      'collections', 'itertools', 'functools', 'operator', 're', 'string', 'io',
      'pathlib', 'typing', 'dataclasses', 'abc', 'contextlib', 'pickle', 'csv',
      'xml', 'sqlite3', 'logging', 'unittest', 'asyncio', 'concurrent', 'threading',
      'multiprocessing', 'subprocess', 'socket', 'email', 'base64', 'hashlib',
      'hmac', 'secrets', 'uuid', 'decimal', 'fractions', 'statistics', 'tempfile'
    ];

    return standardLibModules.some(lib => module === lib || module.startsWith(`${lib}.`));
  }

  private buildModuleHierarchy(modules: Map<string, string[]>, nodes: CASNode[], edges: CASEdge[]): void {
    for (const [moduleName, files] of modules.entries()) {
      const moduleId = `module_${this.sanitizeId(moduleName)}`;

      nodes.push(this.createNode(
        moduleId,
        moduleName,
        'module',
        1,
        undefined,
        undefined,
        undefined,
        {
          fileCount: files.length,
          files: files
        }
      ));

      for (const file of files) {
        const fileId = `file_${this.sanitizeId(file)}`;
        edges.push(this.createEdge(
          `${moduleId}_contains_${fileId}`,
          moduleId,
          fileId,
          'contains'
        ));
      }
    }
  }

  private detectFrameworkPatterns(nodes: CASNode[], _edges: CASEdge[], entryPoints: any[]): void {
    const frameworkDecorators = {
      django: ['django.http', 'django.views', 'django.urls'],
      flask: ['flask.Flask', 'app.route'],
      fastapi: ['fastapi.FastAPI', 'fastapi.APIRouter']
    };

    for (const node of nodes) {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'function' && node.metadata?.attributes?.decorators) {
        const decorators = node.metadata.attributes?.decorators as string[];

        for (const [framework, patterns] of Object.entries(frameworkDecorators)) {
          if (patterns.some(pattern => decorators.some(d => d.includes(pattern)))) {
            entryPoints.push({
              id: `entry_${framework}_${node.id}`,
              name: `${framework.charAt(0).toUpperCase() + framework.slice(1)} endpoint: ${node.name}`,
              type: `${framework}_endpoint`,
              source_node: node.id,
              metadata: {
                framework,
                functionName: node.name
              }
            });
          }
        }
      }
    }
  }

  private buildInheritanceRelationships(nodes: CASNode[], edges: CASEdge[]): void {
    const classNodes = nodes.filter(n => n.type === 'class');
    const classesByName = new Map<string, CASNode>();
    for (const node of classNodes) {
      if (!classesByName.has(node.name)) classesByName.set(node.name, node);
    }

    for (const classNode of classNodes) {
      if (classNode.metadata?.attributes?.baseClasses) {
        const baseClasses = classNode.metadata.attributes.baseClasses as string[];
        for (const baseClassName of baseClasses) {
          const baseClassNode = classesByName.get(baseClassName);

          if (baseClassNode) {
            edges.push(this.createEdge(
              `${classNode.id}_inherits_${baseClassNode.id}`,
              classNode.id,
              baseClassNode.id,
              'inherits'
            ));
          }
        }
      }
    }
  }

  private extractFunctionCalls(
    content: string,
    relativePath: string,
    classes: PythonClass[],
    functions: PythonFunction[],
    nodes: CASNode[],
    edges: CASEdge[],
    exitPoints: CASExitPoint[],
    existingCallIndex?: PythonCallIndex,
  ): void {
    const callIndex = existingCallIndex || buildPythonCallIndex(nodes, edges, exitPoints);
    const lines = content.split('\n');
    const fileId = `file_${this.sanitizeId(relativePath)}`;
    const builtinFunctions = ['print', 'len', 'range', 'int', 'str', 'float', 'bool', 'list', 'dict', 'set',
                             'tuple', 'open', 'input', 'eval', 'exec', 'compile', 'globals', 'locals',
                             'vars', 'dir', 'help', 'type', 'isinstance', 'issubclass', 'hasattr',
                             'getattr', 'setattr', 'delattr', 'callable', 'id', 'hash', 'repr',
                             'abs', 'all', 'any', 'bin', 'chr', 'hex', 'oct', 'ord', 'round',
                             'max', 'min', 'sum', 'sorted', 'reversed', 'enumerate', 'zip', 'map',
                             'filter', 'reduce', 'next', 'iter', 'super', '__import__'];

    for (const cls of classes) {
      const classId = `class_${fileId}_${this.sanitizeId(cls.name)}_${cls.lineStart}`;
      const classNode = callIndex.nodesById.get(classId);
      if (!classNode) continue;

      for (const method of cls.methods) {
        const methodId = `method_${classId}_${this.sanitizeId(method.name)}_${method.lineStart}`;
        const methodNode = callIndex.nodesById.get(methodId);
        if (!methodNode) continue;

        const methodLines = lines.slice(method.lineStart - 1, method.lineEnd);
        this.extractCallsFromBlock(methodLines, method.lineStart, methodNode, edges, exitPoints, builtinFunctions, callIndex);
      }
    }

    for (const func of functions) {
      const functionId = `function_${fileId}_${this.sanitizeId(func.name)}_${func.lineStart}`;
      const functionNode = callIndex.nodesById.get(functionId);
      if (!functionNode) continue;

      const funcLines = lines.slice(func.lineStart - 1, func.lineEnd);
      this.extractCallsFromBlock(funcLines, func.lineStart, functionNode, edges, exitPoints, builtinFunctions, callIndex);
    }
  }

  private extractCallsFromBlock(
    lines: string[],
    startLine: number,
    callerNode: CASNode,
    edges: CASEdge[],
    exitPoints: CASExitPoint[],
    builtinFunctions: string[],
    callIndex: PythonCallIndex,
  ): void {
    const callPatterns = [
      /([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g,
      /self\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g,
      /([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g,
      /await\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g,
      /await\s+self\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g,
      /await\s+([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g
    ];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = startLine + i;

      if (line.trim().startsWith('#')) continue;
      if (line.includes('def ') || line.includes('class ')) continue;

      for (const pattern of callPatterns) {
        let match;
        while ((match = pattern.exec(line)) !== null) {
          let targetObject: string | undefined;
          let targetMethod: string;
          let isAsync = false;

          if (pattern.source.includes('await')) {
            isAsync = true;
          }

          if (pattern.source.includes('self\\.')) {
            targetMethod = match[1];
            const classNode = callerNode.parent ? callIndex.nodesById.get(callerNode.parent) : undefined;
            if (classNode) {
              const targetNode = selectPythonSelfCallTarget(callIndex, classNode.id, targetMethod);

              if (targetNode && targetNode.id !== callerNode.id) {
                const edgeId = `${callerNode.id}_calls_${targetNode.id}_line_${lineNumber}`;
                if (!callIndex.edgeIds.has(edgeId)) {
                  edges.push(this.createEdge(
                    edgeId,
                    callerNode.id,
                    targetNode.id,
                    'calls',
                    'behavior',
                    {
                      call_type: 'self_method_call',
                      is_async: isAsync,
                      line: lineNumber
                    }
                  ));
                  callIndex.edgeIds.add(edgeId);
                }
              }
            }
          } else if (match.length === 3) {
            targetObject = match[1];
            targetMethod = match[2];

            const resolution = selectPythonCallTarget(callIndex, targetMethod, callerNode.source?.file || '');
            const possibleTargets = callIndex.callablesByName.get(targetMethod) || [];

            if (possibleTargets.length > 0) {
              const targetNode = resolution.target;

              if (targetNode && targetNode.id !== callerNode.id) {
                const edgeId = `${callerNode.id}_calls_${targetNode.id}_line_${lineNumber}`;
                if (!callIndex.edgeIds.has(edgeId)) {
                  edges.push(this.createEdge(
                    edgeId,
                    callerNode.id,
                    targetNode.id,
                    'calls',
                    'behavior',
                    {
                      call_type: 'method_call',
                      target_object: targetObject,
                      is_async: isAsync,
                      line: lineNumber,
                      ambiguous: resolution.candidates > 1
                    }
                  ));
                  callIndex.edgeIds.add(edgeId);
                }
              }
            }
          } else if (match.length === 2) {
            targetMethod = match[1];

            if (builtinFunctions.includes(targetMethod)) {
              continue;
            } else {
              const resolution = selectPythonCallTarget(callIndex, targetMethod, callerNode.source?.file || '');
              const possibleTargets = callIndex.callablesByName.get(targetMethod) || [];

              if (possibleTargets.length > 0) {
                const targetNode = resolution.target;

                if (targetNode && targetNode.id !== callerNode.id) {
                  const edgeId = `${callerNode.id}_calls_${targetNode.id}_line_${lineNumber}`;
                  if (!callIndex.edgeIds.has(edgeId)) {
                    edges.push(this.createEdge(
                      edgeId,
                      callerNode.id,
                      targetNode.id,
                      'calls',
                      'behavior',
                      {
                        call_type: 'function_call',
                        is_async: isAsync,
                        line: lineNumber,
                        ambiguous: resolution.candidates > 1
                      }
                    ));
                    callIndex.edgeIds.add(edgeId);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  private buildCallGraph(nodes: CASNode[], edges: CASEdge[], entryPoints: CASEntryPoint[], exitPoints: CASExitPoint[]): void {
    const decoratorPatterns = [
      { pattern: /@app\.route\(['"]([^'"]+)['"]/, framework: 'flask', method: 'GET' },
      { pattern: /@app\.get\(['"]([^'"]+)['"]/, framework: 'flask', method: 'GET' },
      { pattern: /@app\.post\(['"]([^'"]+)['"]/, framework: 'flask', method: 'POST' },
      { pattern: /@app\.put\(['"]([^'"]+)['"]/, framework: 'flask', method: 'PUT' },
      { pattern: /@app\.delete\(['"]([^'"]+)['"]/, framework: 'flask', method: 'DELETE' },
      { pattern: /@app\.patch\(['"]([^'"]+)['"]/, framework: 'flask', method: 'PATCH' },
      { pattern: /@router\.get\(['"]([^'"]+)['"]/, framework: 'fastapi', method: 'GET' },
      { pattern: /@router\.post\(['"]([^'"]+)['"]/, framework: 'fastapi', method: 'POST' },
      { pattern: /@router\.put\(['"]([^'"]+)['"]/, framework: 'fastapi', method: 'PUT' },
      { pattern: /@router\.delete\(['"]([^'"]+)['"]/, framework: 'fastapi', method: 'DELETE' },
      { pattern: /@router\.patch\(['"]([^'"]+)['"]/, framework: 'fastapi', method: 'PATCH' },
      { pattern: /@router\.websocket\(['"]([^'"]+)['"]/, framework: 'fastapi', method: 'WEBSOCKET' },
      { pattern: /@\w+\.get\(['"]([^'"]+)['"]/, framework: 'fastapi', method: 'GET' },
      { pattern: /@\w+\.post\(['"]([^'"]+)['"]/, framework: 'fastapi', method: 'POST' },
      { pattern: /@\w+\.put\(['"]([^'"]+)['"]/, framework: 'fastapi', method: 'PUT' },
      { pattern: /@\w+\.delete\(['"]([^'"]+)['"]/, framework: 'fastapi', method: 'DELETE' },
      { pattern: /@\w+\.patch\(['"]([^'"]+)['"]/, framework: 'fastapi', method: 'PATCH' },
      { pattern: /@\w+\.websocket\(['"]([^'"]+)['"]/, framework: 'fastapi', method: 'WEBSOCKET' },
    ];
    const entryPointIds = new Set(entryPoints.map(entryPoint => entryPoint.id));

    for (const node of nodes) {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'function' || node.type === 'method') {
        const decorators = node.metadata?.attributes?.decorators as string[] || [];

        for (const decorator of decorators) {
          for (const { pattern, framework, method } of decoratorPatterns) {
            const match = decorator.match(pattern);
            if (match) {
              const routePath = match[1];
              const entryPointId = `entry_http_${node.id}_${method.toLowerCase()}`;

              if (!entryPointIds.has(entryPointId)) {
                entryPoints.push({
                  id: entryPointId,
                  source_node: node.id,
                  type: 'http',
                  name: `HTTP ${method} ${routePath}`,
                  trigger: {
                    method,
                    path: routePath
                  },
                  metadata: {
                    framework,
                    decorator
                  }
                } as CASEntryPoint);
                entryPointIds.add(entryPointId);
              }

              if (!node.metadata) node.metadata = {};
              if (!node.metadata.attributes) node.metadata.attributes = {};
              node.metadata.attributes.httpEndpoint = true;
              node.metadata.attributes.httpMethod = method;
              node.metadata.attributes.httpPath = routePath;
              node.metadata.attributes.framework = framework;
            }
          }
        }
      }
    }
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
      'function-detection',
      'module-organization',
      'inheritance-tracking',
      'decorator-parsing',
      'async-pattern-detection',
      'framework-detection',
      'documentation-extraction',
      'comment-analysis',
      'todo-detection',
      'implementation-status'
    ];
  }

  private extractCommentsFromFile(content: string, filePath: string): CASComment[] {
    const comments: CASComment[] = [];
    let commentSeq = 0;
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      const singleLineMatch = line.match(/#(.*)$/);
      if (singleLineMatch) {
        const text = singleLineMatch[1].trim();
        const purpose = this.classifyCommentPurpose(text);
        comments.push({
          id: `comment_${filePath}_${++commentSeq}`,
          type: 'single-line',
          style: '#',
          text,
          purpose,
          location: {
            file: filePath,
            line: index + 1,
            relative_to: 'above'
          },
          markers: this.extractCommentMarkers(text)
        });
      }
    });

    return comments;
  }

  private extractCommentsFromContent(content: string, filePath: string, lineOffset: number = 0): CASComment[] {
    const comments: CASComment[] = [];
    let commentSeq = 0;
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      const singleLineMatch = line.match(/#(.*)$/);
      if (singleLineMatch) {
        const text = singleLineMatch[1].trim();
        const purpose = this.classifyCommentPurpose(text);
        comments.push({
          id: `comment_${filePath}_${++commentSeq}`,
          type: 'single-line',
          style: '#',
          text,
          purpose,
          location: {
            file: filePath,
            line: lineOffset + index,
            relative_to: 'above'
          },
          markers: this.extractCommentMarkers(text)
        });
      }
    });

    return comments;
  }

  private extractCommentMarkers(text: string): any {
    return {
      is_todo: /\b(TODO|TO DO)\b/i.test(text),
      is_fixme: /\bFIXME\b/i.test(text),
      is_hack: /\bHACK\b/i.test(text),
      is_warning: /\b(WARNING|WARN)\b/i.test(text),
      is_note: /\bNOTE\b/i.test(text),
      is_question: /\?/.test(text) && text.length < 100,
      is_important: /\b(IMPORTANT|CRITICAL)\b/i.test(text)
    };
  }

  private classifyCommentPurpose(text: string): CASComment['purpose'] {
    if (/\b(TODO|FIXME|HACK)\b/i.test(text)) return 'todo';
    if (/\b(WARNING|WARN|DANGER)\b/i.test(text)) return 'warning';
    if (/\bNOTE\b/i.test(text)) return 'note';
    if (/\bHACK\b/i.test(text)) return 'hack';
    if (/^\s*#.+\s*$/.test(text) && text.includes('#')) return 'disabled-code';
    if (text.length < 50 && /explains?|because|since|why/i.test(text)) return 'clarification';
    return 'explanation';
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

        todos.push({
          id: `todo_${comment.location.file}_${comment.location.line}_${++todoSeq}`,
          type,
          text: comment.text,
          priority,
          assignee,
          location: {
            file: comment.location.file,
            line: comment.location.line,
            node_id: context
          },
          classification: {
            category: type === 'FIXME' ? 'bug' :
                     type === 'OPTIMIZE' ? 'performance' :
                     type === 'REFACTOR' ? 'refactor' : 'feature',
            technical_debt: true,
            blocking: priority === 'high'
          }
        });
      }
    });

    return todos;
  }

  private extractDocumentationFromDocstring(docstring: string, type: 'function' | 'class' | 'method' = 'function'): CASDocumentation | undefined {
    if (!docstring || !docstring.trim()) return undefined;

    const lines = docstring.split('\n').map(line => line.trim());
    const firstLine = lines[0];

    const isGoogleStyle = /Args:|Arguments:|Returns?:|Yields?:|Raises?:|Note:|Example:/i.test(docstring);
    const isNumpyStyle = /Parameters\s*\n\s*-+|Returns\s*\n\s*-+|Raises\s*\n\s*-+/i.test(docstring);
    const isSphinxStyle = /:param |:type |:returns?:|:rtype:|:raises?:/i.test(docstring);

    let docType: CASDocumentation['type'] = 'docstring';
    if (isSphinxStyle) docType = 'docstring';
    else if (isGoogleStyle || isNumpyStyle) docType = 'docstring';

    const summary = firstLine;

    let description = '';
    let parameterSection = '';
    let returnsSection = '';
    let examplesSection = '';

    let currentSection = 'description';
    let sectionContent = '';

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

      if (/^(Args?|Arguments?|Parameters?):/i.test(line)) {
        if (currentSection === 'description') description = sectionContent.trim();
        currentSection = 'parameters';
        sectionContent = '';
      } else if (/^Returns?:/i.test(line)) {
        if (currentSection === 'parameters') parameterSection = sectionContent.trim();
        currentSection = 'returns';
        sectionContent = '';
      } else if (/^Examples?:/i.test(line)) {
        if (currentSection === 'returns') returnsSection = sectionContent.trim();
        currentSection = 'examples';
        sectionContent = '';
      } else {
        sectionContent += line + '\n';
      }
    }

    if (currentSection === 'description') description = sectionContent.trim();
    else if (currentSection === 'parameters') parameterSection = sectionContent.trim();
    else if (currentSection === 'returns') returnsSection = sectionContent.trim();
    else if (currentSection === 'examples') examplesSection = sectionContent.trim();

    const parameters: Array<{name: string; type?: string; description?: string; optional?: boolean}> = [];
    if (parameterSection) {
      const paramLines = parameterSection.split('\n');
      for (const paramLine of paramLines) {
        const paramMatch = paramLine.match(/^\s*(\w+)\s*(?:\(([^)]+)\))?\s*:?\s*(.*)$/);
        if (paramMatch) {
          parameters.push({
            name: paramMatch[1],
            type: paramMatch[2]?.trim(),
            description: paramMatch[3]?.trim(),
            optional: paramMatch[2]?.includes('optional') || false
          });
        }
      }
    }

    let returns: {type?: string; description?: string} | undefined;
    if (returnsSection) {
      const returnMatch = returnsSection.match(/^\s*(?:([^:]+):\s*)?(.*)$/);
      if (returnMatch) {
        returns = {
          type: returnMatch[1]?.trim(),
          description: returnMatch[2]?.trim()
        };
      }
    }

    const examples: Array<{title?: string; code: string; language?: string}> = [];
    if (examplesSection) {
      examples.push({
        code: examplesSection,
        language: 'python'
      });
    }

    return {
      type: docType,
      raw: docstring,
      summary: summary || undefined,
      description: description || undefined,
      parameters: parameters.length > 0 ? parameters : undefined,
      returns,
      examples: examples.length > 0 ? examples : undefined,
      location: {
        start_line: 1,
        end_line: lines.length
      }
    };
  }

  private detectImplementationStatus(content: string, functionLines: string[], startLine: number, endLine: number): CASImplementationStatus | undefined {
    if (!functionLines || functionLines.length === 0) return undefined;

    const bodyStr = functionLines.join('\n');
    const fullBodyStr = content.split('\n').slice(startLine - 1, endLine).join('\n');

    const indicators = {
      has_todo_markers: /\b(TODO|FIXME|HACK)\b/i.test(fullBodyStr),
      has_not_implemented_exceptions: /raise\s+(NotImplementedError|NotImplemented)/i.test(bodyStr),
      has_stub_returns: /return\s+(None|False|0|''|""|\[\]|\{\})\s*$/m.test(bodyStr),
      has_placeholder_code: /print\s*\(['"](TODO|PLACEHOLDER|TEMP)/i.test(bodyStr),
      has_hardcoded_values: /(TODO|PLACEHOLDER|TEMP|FIXME)/i.test(bodyStr),
      has_commented_out_code: /#.*\w+\s*\(/.test(bodyStr) || /^\s*'''[\s\S]*?'''/m.test(bodyStr)
    };

    const hasImplementation = bodyStr.trim().length > 10 &&
                            !bodyStr.trim().match(/^\s*pass\s*$/) &&
                            !bodyStr.trim().match(/^\s*\.\.\.$/);

    let status: CASImplementationStatus['status'] = 'complete';
    if (!hasImplementation || /^\s*pass\s*$/m.test(bodyStr) || /^\s*\.\.\.$/.test(bodyStr)) {
      status = 'stub';
    } else if (indicators.has_not_implemented_exceptions) {
      status = 'not-implemented';
    } else if (indicators.has_todo_markers || indicators.has_stub_returns) {
      status = 'partial';
    }

    const deprecatedMatch = fullBodyStr.match(/@deprecated|# deprecated/i);
    if (deprecatedMatch) {
      status = 'deprecated';
    }

    const experimentalMatch = fullBodyStr.match(/@experimental|# experimental/i);
    if (experimentalMatch) {
      status = 'experimental';
    }

    return {
      status,
      indicators,
      completeness: status === 'complete' ? { estimated_percentage: 100 } :
                   status === 'partial' ? { estimated_percentage: 50 } :
                   status === 'stub' ? { estimated_percentage: 10 } :
                   { estimated_percentage: 0 }
    };
  }

  private applyTestFileBoundary(nodes: CASNode[]): void {
    for (const node of nodes) {
      const file = node.source?.file;
      if (!file || !this.isPythonTestPath(file)) continue;
      node.metadata = { ...node.metadata, is_test: true };
      node.category = 'test';
      node.subcategories = [...new Set([...(node.subcategories || []), node.type, 'test-code'])];
      node.tags = [...new Set([...(node.tags || []), 'test-code'])];
    }
  }

  private isPythonTestPath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    const basename = normalized.split('/').pop() || normalized;
    return /(?:^|\/)tests?\//i.test(normalized) ||
      /^test_[^/]+\.py$/i.test(basename) ||
      /_test\.py$/i.test(basename);
  }
}
