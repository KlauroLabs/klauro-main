import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, CASDocumentation, CASComment, CASTodo, CASImplementationStatus, FileAnalysisResult } from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import { detectSyntaxDegradation } from '../core/syntax-degradation';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';
import { maskCStyleComments } from '../core/source-comment-mask';
import {
  findClassSpringMappingPath,
  joinSpringRoutePaths,
} from './java-source-structure';

interface JavaClass {
  name: string;
  packageName: string;
  filePath: string;
  modifiers: string[];
  extends?: string;
  implementsInterfaces: string[];
  fields: JavaField[];
  methods: JavaMethod[];
  innerClasses: string[];
  annotations: string[];
  lineStart: number;
  lineEnd: number;
  isRecord?: boolean;
}

interface JavaMethod {
  name: string;
  returnType: string;
  parameters: JavaParameter[];
  modifiers: string[];
  annotations: string[];
  throwsExceptions: string[];
  lineStart: number;
  lineEnd: number;
  isConstructor: boolean;
  isAbstract: boolean;
  isStatic: boolean;
}

interface JavaField {
  name: string;
  type: string;
  modifiers: string[];
  annotations: string[];
  initialValue?: string;
  isStatic: boolean;
  isFinal: boolean;
  lineNumber: number;
}

interface JavaParameter {
  name: string;
  type: string;
  annotations: string[];
  isFinal: boolean;
}

interface JavaInterface {
  name: string;
  packageName: string;
  filePath: string;
  extends: string[];
  methods: JavaMethod[];
  fields: JavaField[];
  annotations: string[];
  lineStart: number;
  lineEnd: number;
}

interface JavaImport {
  importPath: string;
  isStatic: boolean;
  isWildcard: boolean;
  lineNumber: number;
}

export class JavaAnalyzer extends BaseAnalyzer {
  private springFrameworkDetected = false;
  private mavenProject = false;
  private gradleProject = false;

  constructor() {
    super(
      'java',
      'Java Language Analyzer',
      '1.0.0',
      'language'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const javaFiles = await glob(['**/*.java'], {
        cwd: projectPath,
        ignore: this.getJavaIgnorePatterns({ projectPath }),
        nodir: true
      });

      const buildFiles = await glob(['pom.xml', 'build.gradle', 'gradle.build'], {
        cwd: projectPath,
        ignore: this.getJavaIgnorePatterns({ projectPath }),
        nodir: true
      });

      return javaFiles.length > 0 || buildFiles.length > 0;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  private getJavaIgnorePatterns(context: AnalysisContext | { projectPath: string }): string[] {
    return this.getPackageDirSafeIgnorePatterns(context as AnalysisContext);
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {

    const files = await glob(['**/*.java'], {
      cwd: projectPath,
      ignore: this.getJavaIgnorePatterns({ projectPath }),
      nodir: true
    });
    return files.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const packages = new Map<string, string[]>();
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    await this.detectProjectType(context.projectPath);
    await this.analyzeJavaFile(context.filePath, context.relativePath, nodes, edges, entryPoints, exitPoints, packages, context);
    this.detectSpringPatterns(nodes, edges, entryPoints);
    this.buildInheritanceRelationships(nodes, edges);
    await this.analyzeCallGraph(context.projectPath, nodes, edges, entryPoints, exitPoints);
    this.applyTestFileBoundary(nodes);

    const imports = this.extractImports(content).map(imp => imp.importPath);
    const exports = nodes
      .filter(node => ['class', 'interface', 'method', 'field'].includes(node.type))
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

      const javaFiles = await glob(['**/*.java'], {
        cwd: context.projectPath,
        ignore: this.getJavaIgnorePatterns(context),
        nodir: true
      });
      javaFiles.sort();

      const packages = new Map<string, string[]>();

      for (const file of javaFiles) {
        const fullPath = `${context.projectPath}/${file}`;
        await this.analyzeJavaFile(fullPath, file, nodes, edges, entryPoints, exitPoints, packages, context);
      }

      this.buildPackageHierarchy(packages, nodes, edges);
      this.detectSpringPatterns(nodes, edges, entryPoints);
      this.buildInheritanceRelationships(nodes, edges);

      await this.analyzeCallGraph(context.projectPath, nodes, edges, entryPoints, exitPoints);
      this.applyTestFileBoundary(nodes);

      const warnings = this.collectAnalysisWarnings();
      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        ...(warnings.length > 0 ? { warnings } : {}),
        framework_specific: {
          language: 'java',
          springFramework: this.springFrameworkDetected,
          buildTool: this.mavenProject ? 'maven' : this.gradleProject ? 'gradle' : 'unknown',
          libraries,
          filesAnalyzed: javaFiles.length,
          packagesFound: packages.size
        }
      });

    } catch (error) {
      throw new AnalyzerError(
        `Java analysis failed: ${(error as Error).message}`,
        'JAVA_ANALYSIS_ERROR'
      );
    }
  }

  private async detectProjectType(projectPath: string): Promise<void> {
    const pomPath = `${projectPath}/pom.xml`;
    const gradlePath = `${projectPath}/build.gradle`;

    this.mavenProject = await fs.pathExists(pomPath);
    this.gradleProject = await fs.pathExists(gradlePath);

    if (this.mavenProject) {
      const pomContent = await fs.readFile(pomPath, 'utf-8');
      this.springFrameworkDetected = pomContent.includes('spring-boot') ||
                                   pomContent.includes('springframework');
    }

    if (this.gradleProject) {
      const gradleContent = await fs.readFile(gradlePath, 'utf-8');
      this.springFrameworkDetected = gradleContent.includes('spring-boot') ||
                                   gradleContent.includes('springframework');
    }
  }

  private async extractDependencies(projectPath: string, libraries: any[]): Promise<void> {
    if (this.mavenProject) {
      await this.extractMavenDependencies(projectPath, libraries);
    }

    if (this.gradleProject) {
      await this.extractGradleDependencies(projectPath, libraries);
    }
  }

  private async extractMavenDependencies(projectPath: string, libraries: any[]): Promise<void> {
    const pomPath = `${projectPath}/pom.xml`;
    try {
      const pomContent = await fs.readFile(pomPath, 'utf-8');
      const dependencyMatches = pomContent.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g);

      for (const match of Array.from(dependencyMatches)) {
        const depContent = match[1];
        const groupId = this.extractXmlValue(depContent, 'groupId');
        const artifactId = this.extractXmlValue(depContent, 'artifactId');
        const version = this.extractXmlValue(depContent, 'version');
        const scope = this.extractXmlValue(depContent, 'scope') || 'compile';

        if (groupId && artifactId) {
          libraries.push({
            name: `${groupId}:${artifactId}`,
            version: version || 'unknown',
            type: 'maven_dependency',
            source: 'pom.xml',
            metadata: {
              groupId,
              artifactId,
              scope,
              isTestDependency: scope === 'test'
            }
          });
        }
      }
    } catch (error) {
      console.warn('Failed to parse pom.xml:', error);
    }
  }

  private async extractGradleDependencies(projectPath: string, libraries: any[]): Promise<void> {
    const gradlePath = `${projectPath}/build.gradle`;
    try {
      const gradleContent = await fs.readFile(gradlePath, 'utf-8');
      const depLines = gradleContent.split('\n').filter(line =>
        line.trim().match(/^(implementation|compile|testImplementation|api|runtimeOnly)\s+/));

      for (const line of depLines) {
        const match = line.match(/^(\w+)\s+['"]([^'"]+)['"]/);
        if (match) {
          const scope = match[1];
          const dependency = match[2];

          libraries.push({
            name: dependency,
            version: 'unknown',
            type: 'gradle_dependency',
            source: 'build.gradle',
            metadata: {
              scope,
              isTestDependency: scope.includes('test')
            }
          });
        }
      }
    } catch (error) {
      console.warn('Failed to parse build.gradle:', error);
    }
  }

  private async analyzeJavaFile(
    fullPath: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[],
    exitPoints: any[],
    packages: Map<string, string[]>,
    _context: AnalysisContext
  ): Promise<void> {
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');

      const packageName = this.extractPackage(content);
      const imports = this.extractImports(content);
      const classes = this.extractClasses(content, relativePath);
      const records = this.extractRecords(content, relativePath);
      const interfaces = this.extractInterfaces(content, relativePath);
      const degradation = detectSyntaxDegradation({
        relativePath,
        content,
        language: 'java',
        extractedNodeCount: classes.length + records.length + interfaces.length,
      });
      if (degradation) this.addAnalysisWarning(degradation);
      const comments = this.extractComments(content, relativePath);
      const todos = this.extractTodos(content, relativePath);

      if (packageName) {
        if (!packages.has(packageName)) {
          packages.set(packageName, []);
        }
        packages.get(packageName)!.push(relativePath);
      }

      const fileId = `file_${this.sanitizeId(relativePath)}`;
      const fileNode = this.createNode(
        fileId,
        relativePath.split('/').pop() || 'unknown.java',
        'file',
        1,
        relativePath,
        1,
        lines.length,
        {
          packageName: packageName || 'default',
          imports: imports.map(i => i.importPath),
          classCount: classes.length + records.length,
          interfaceCount: interfaces.length,
          commentCount: comments.length,
          todoCount: todos.length
        }
      );

      if (comments.length > 0) {
        fileNode.comments = comments;
      }
      if (todos.length > 0) {
        fileNode.todos = todos;
      }

      nodes.push(fileNode);

      for (const imp of imports) {
        const importId = `import_${fileId}_${this.sanitizeId(imp.importPath)}`;
        nodes.push(this.createNode(
          importId,
          imp.importPath,
          'import',
          2,
          relativePath,
          imp.lineNumber,
          imp.lineNumber,
          {
            isStatic: imp.isStatic,
            isWildcard: imp.isWildcard
          }
        ));

        edges.push(this.createEdge(
          `${fileId}_imports_${importId}`,
          fileId,
          importId,
          'imports'
        ));

        if (!imp.importPath.startsWith(packageName || '')) {
          exitPoints.push({
            id: `exit_${importId}`,
            name: `External dependency: ${imp.importPath}`,
            type: 'external_import',
            source_node: importId,
            metadata: { importPath: imp.importPath }
          });
        }
      }

      for (const cls of classes) {
        await this.processJavaClass(cls, fileId, relativePath, nodes, edges, entryPoints, comments, todos, content, lines);
      }

      for (const rec of records) {
        await this.processJavaClass(rec, fileId, relativePath, nodes, edges, entryPoints, comments, todos, content, lines);
      }

      for (const intf of interfaces) {
        await this.processJavaInterface(intf, fileId, relativePath, nodes, edges, entryPoints, comments, todos, content, lines);
      }

    } catch (error) {
      console.warn(`Failed to analyze Java file ${relativePath}:`, error);
    }
  }

  private async processJavaClass(
    cls: JavaClass,
    fileId: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[],
    comments: CASComment[],
    todos: CASTodo[],
    content: string,
    lines: string[]
  ): Promise<void> {
    const classId = `class_${this.sanitizeId(cls.packageName)}_${this.sanitizeId(cls.name)}`;

    const classJavadoc = this.extractJavaDoc(lines, cls.lineStart - 1);
    const classComments = comments.filter(c =>
      c.location.line >= cls.lineStart && c.location.line <= cls.lineEnd
    );
    const classTodos = todos.filter(t =>
      t.location.line >= cls.lineStart && t.location.line <= cls.lineEnd
    );

    const classStatus = (cls.modifiers.includes('abstract') || cls.annotations.includes('Deprecated'))
      ? this.analyzeImplementationStatus(lines, cls.lineStart - 1, cls.lineEnd - 1, cls.annotations)
      : undefined;

    const classNode = this.createNodeBuilder(
      classId,
      cls.name,
      'class'
    )
      .withLevel(2, 'Class/Interface')
      .withCategory('structures', ['classes'])
      .withSource({ file: relativePath, line: cls.lineStart, end_line: cls.lineEnd })
      .withMetadata({
        attributes: {
          packageName: cls.packageName,
          modifiers: cls.modifiers,
          extends: cls.extends,
          implementsInterfaces: cls.implementsInterfaces,
          annotations: cls.annotations,
          fieldCount: cls.fields.length,
          methodCount: cls.methods.length,
          isPublic: cls.modifiers.includes('public'),
          isAbstract: cls.modifiers.includes('abstract'),
          isFinal: cls.modifiers.includes('final'),
          isRecord: !!cls.isRecord
        }
      })
      .withDocumentation(classJavadoc)
      .withComments(classComments.length > 0 ? classComments : undefined)
      .withTodos(classTodos.length > 0 ? classTodos : undefined)
      .withImplementationStatus(classStatus)
      .build();

    nodes.push(classNode);

    edges.push(this.createEdge(
      `${fileId}_contains_${classId}`,
      fileId,
      classId,
      'contains'
    ));

    for (const field of cls.fields) {
      const fieldId = `field_${classId}_${this.sanitizeId(field.name)}`;
      nodes.push(this.createNode(
        fieldId,
        field.name,
        'field',
        4,
        relativePath,
        field.lineNumber,
        field.lineNumber,
        {
          type: field.type,
          modifiers: field.modifiers,
          annotations: field.annotations,
          isStatic: field.isStatic,
          isFinal: field.isFinal,
          initialValue: field.initialValue
        }
      ));

      edges.push(this.createEdge(
        `${classId}_has_field_${fieldId}`,
        classId,
        fieldId,
        'has_field'
      ));
    }

    for (const method of cls.methods) {
      const methodId = `method_${classId}_${this.sanitizeId(method.name)}_${method.lineStart}`;

      const javadoc = this.extractJavaDoc(lines, method.lineStart - 1);
      const implementationStatus = this.analyzeImplementationStatus(lines, method.lineStart - 1, method.lineEnd - 1, method.annotations);

      const methodComments = comments.filter(c =>
        c.location.line >= method.lineStart && c.location.line <= method.lineEnd
      );
      const methodTodos = todos.filter(t =>
        t.location.line >= method.lineStart && t.location.line <= method.lineEnd
      );

      const thrownTypes = this.extractThrownTypes(lines, method.lineStart, method.lineEnd);
      const signatureThrows = this.buildSignatureThrows(method.throwsExceptions, javadoc, thrownTypes);

      const methodNode = this.createNodeBuilder(
        methodId,
        method.name,
        'method'
      )
        .withLevel(4, 'Method/Function')
        .withCategory('methods', ['class-methods'])
        .withSource({ file: relativePath, line: method.lineStart, end_line: method.lineEnd })
        .withMetadata({
          attributes: {
            returnType: method.returnType,
            parameters: method.parameters,
            modifiers: method.modifiers,
            annotations: method.annotations,
            throwsExceptions: method.throwsExceptions,
            isConstructor: method.isConstructor,
            isAbstract: method.isAbstract,
            isStatic: method.isStatic,
            isPublic: method.modifiers.includes('public')
          }
        })
        .withSignature({
          parameters: method.parameters.map(p => ({ name: p.name, type: p.type })),
          return_type: method.returnType || undefined,
          throws: signatureThrows
        })
        .withParent(classId)
        .withDocumentation(javadoc)
        .withComments(methodComments.length > 0 ? methodComments : undefined)
        .withTodos(methodTodos.length > 0 ? methodTodos : undefined)
        .withImplementationStatus(implementationStatus)
        .build();

      nodes.push(methodNode);

      edges.push(this.createEdge(
        `${classId}_has_method_${methodId}`,
        classId,
        methodId,
        'has_method'
      ));

      if (method.modifiers.includes('public') && !method.isConstructor) {
        entryPoints.push({
          id: `entry_${methodId}`,
          name: `Public method: ${cls.name}.${method.name}`,
          type: 'public_method',
          source_node: methodId,
          metadata: {
            className: cls.name,
            methodName: method.name,
            returnType: method.returnType,
            parameters: method.parameters.map(p => p.type)
          }
        });
      }
    }

    if (cls.modifiers.includes('public')) {
      entryPoints.push({
        id: `entry_${classId}`,
        name: `Public class: ${cls.name}`,
        type: 'public_class',
        source_node: classId,
        metadata: {
          packageName: cls.packageName,
          className: cls.name,
          annotations: cls.annotations
        }
      });
    }
  }

  private async processJavaInterface(
    intf: JavaInterface,
    fileId: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[],
    comments: CASComment[],
    todos: CASTodo[],
    content: string,
    lines: string[]
  ): Promise<void> {
    const interfaceId = `interface_${this.sanitizeId(intf.packageName)}_${this.sanitizeId(intf.name)}`;

    const interfaceJavadoc = this.extractJavaDoc(lines, intf.lineStart - 1);
    const interfaceComments = comments.filter(c =>
      c.location.line >= intf.lineStart && c.location.line <= intf.lineEnd
    );
    const interfaceTodos = todos.filter(t =>
      t.location.line >= intf.lineStart && t.location.line <= intf.lineEnd
    );

    const interfaceNode = this.createNode(
      interfaceId,
      intf.name,
      'interface',
      2,
      relativePath,
      intf.lineStart,
      intf.lineEnd,
      {
        packageName: intf.packageName,
        extends: intf.extends,
        annotations: intf.annotations,
        methodCount: intf.methods.length,
        fieldCount: intf.fields.length
      }
    );

    if (interfaceJavadoc) {
      interfaceNode.documentation = interfaceJavadoc;
    }
    if (interfaceComments.length > 0) {
      interfaceNode.comments = interfaceComments;
    }
    if (interfaceTodos.length > 0) {
      interfaceNode.todos = interfaceTodos;
    }

    nodes.push(interfaceNode);

    edges.push(this.createEdge(
      `${fileId}_contains_${interfaceId}`,
      fileId,
      interfaceId,
      'contains'
    ));

    for (const method of intf.methods) {
      const methodId = `method_${interfaceId}_${this.sanitizeId(method.name)}_${method.lineStart}`;

      const javadoc = this.extractJavaDoc(lines, method.lineStart - 1);

      const methodComments = comments.filter(c =>
        c.location.line >= method.lineStart && c.location.line <= method.lineEnd
      );
      const methodTodos = todos.filter(t =>
        t.location.line >= method.lineStart && t.location.line <= method.lineEnd
      );

      const thrownTypes = this.extractThrownTypes(lines, method.lineStart, method.lineEnd);
      const signatureThrows = this.buildSignatureThrows(method.throwsExceptions, javadoc, thrownTypes);

      const methodNode = this.createNodeBuilder(
        methodId,
        method.name,
        'interface_method'
      )
        .withLevel(4, 'Method/Function')
        .withCategory('methods', ['interface-methods'])
        .withSource({ file: relativePath, line: method.lineStart, end_line: method.lineEnd })
        .withMetadata({
          attributes: {
            returnType: method.returnType,
            parameters: method.parameters,
            annotations: method.annotations,
            throwsExceptions: method.throwsExceptions
          }
        })
        .withSignature({
          parameters: method.parameters.map(p => ({ name: p.name, type: p.type })),
          return_type: method.returnType || undefined,
          throws: signatureThrows
        })
        .withParent(interfaceId)
        .withDocumentation(javadoc)
        .withComments(methodComments.length > 0 ? methodComments : undefined)
        .withTodos(methodTodos.length > 0 ? methodTodos : undefined)
        .build();

      nodes.push(methodNode);

      edges.push(this.createEdge(
        `${interfaceId}_declares_${methodId}`,
        interfaceId,
        methodId,
        'declares'
      ));
    }

    entryPoints.push({
      id: `entry_${interfaceId}`,
      name: `Interface: ${intf.name}`,
      type: 'interface',
      source_node: interfaceId,
      metadata: {
        packageName: intf.packageName,
        interfaceName: intf.name,
        annotations: intf.annotations
      }
    });
  }

  private extractPackage(content: string): string | null {
    const packageMatch = content.match(/^package\s+([a-zA-Z0-9_.]+)\s*;/m);
    return packageMatch ? packageMatch[1] : null;
  }

  private extractImports(content: string): JavaImport[] {
    const imports: JavaImport[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const importMatch = line.match(/^import\s+(static\s+)?([a-zA-Z0-9_.$*]+)\s*;/);

      if (importMatch) {
        const isStatic = !!importMatch[1];
        const importPath = importMatch[2];
        const isWildcard = importPath.endsWith('*');

        imports.push({
          importPath,
          isStatic,
          isWildcard,
          lineNumber: i + 1
        });
      }
    }

    return imports;
  }

  private extractClasses(content: string, filePath: string): JavaClass[] {
    const classes: JavaClass[] = [];
    const lines = content.split('\n');
    const structuralLines = maskCStyleComments(content).split('\n');
    const packageName = this.extractPackage(content) || 'default';

    for (let i = 0; i < lines.length; i++) {
      const line = structuralLines[i].trim();

      if (line.includes('class ') && !line.startsWith('//') && !line.includes('interface')) {
        const classMatch = line.match(/\b(public|private|protected|abstract|final|\s)*\s*class\s+(\w+)/);

        if (classMatch) {
          const modifiers = this.extractModifiers(line);
          const className = classMatch[2];
          const extendsMatch = line.match(/extends\s+(\w+)/);
          const implementsMatch = line.match(/implements\s+([^{]+)/);

          const implementsInterfaces: string[] = implementsMatch
            ? implementsMatch[1].split(',').map(s => s.trim())
            : [];

          const classStartLine = i + 1;
          const classEndLine = this.findClassEnd(structuralLines, i);

          const fields = this.extractFields(lines, i, classEndLine);
          const methods = this.extractMethods(lines, i, classEndLine);
          const annotations = this.extractAnnotations(lines, i);

          classes.push({
            name: className,
            packageName,
            filePath,
            modifiers,
            extends: extendsMatch ? extendsMatch[1] : undefined,
            implementsInterfaces,
            fields,
            methods,
            innerClasses: [],
            annotations,
            lineStart: classStartLine,
            lineEnd: classEndLine
          });
        }
      }
    }

    return classes;
  }

  private extractRecords(content: string, filePath: string): JavaClass[] {
    const records: JavaClass[] = [];
    const lines = content.split('\n');
    const structuralLines = maskCStyleComments(content).split('\n');
    const packageName = this.extractPackage(content) || 'default';

    for (let i = 0; i < lines.length; i++) {
      const line = structuralLines[i].trim();
      if (!/\brecord\s+\w+\s*\(/.test(line) || line.startsWith('//')) continue;

      const header = this.collectRecordComponentString(lines, i);
      if (!header) continue;

      const modifiers = this.extractModifiers(lines[i]);
      const afterParens = lines[header.endIndex].slice(header.charAfterClose);
      const implementsMatch = afterParens.match(/implements\s+([^{]+)/);
      const implementsInterfaces = implementsMatch
        ? implementsMatch[1].split(',').map(s => s.trim())
        : [];

      const classStartLine = i + 1;
      const classEndLine = this.findClassEnd(structuralLines, i);

      const componentFields = this.extractRecordComponents(header.components, classStartLine);
      const bodyFields = this.extractFields(lines, i, classEndLine);
      const methods = this.extractMethods(lines, i, classEndLine);
      const annotations = this.extractAnnotations(lines, i);

      records.push({
        name: header.name,
        packageName,
        filePath,
        modifiers,
        extends: undefined,
        implementsInterfaces,
        fields: [...componentFields, ...bodyFields],
        methods,
        innerClasses: [],
        annotations,
        lineStart: classStartLine,
        lineEnd: classEndLine,
        isRecord: true
      });
    }

    return records;
  }

  private collectRecordComponentString(
    lines: string[],
    startIndex: number,
    maxLines = 60
  ): { name: string; components: string; endIndex: number; charAfterClose: number } | undefined {
    const headerLine = lines[startIndex];
    const nameMatch = headerLine.match(/\brecord\s+(\w+)\s*\(/);
    if (!nameMatch || nameMatch.index === undefined) return undefined;

    const name = nameMatch[1];
    let depth = 0;
    let components = '';

    for (let i = startIndex; i < lines.length && i - startIndex < maxLines; i++) {
      const line = i === startIndex ? headerLine.slice(nameMatch.index + nameMatch[0].length) : lines[i];

      for (let c = 0; c < line.length; c++) {
        const character = line[c];
        if (character === '(') {
          depth += 1;
          components += character;
        } else if (character === ')') {
          if (depth === 0) {
            return { name, components, endIndex: i, charAfterClose: c + 1 };
          }
          depth -= 1;
          components += character;
        } else {
          components += character;
        }
      }
      components += ' ';
    }

    return undefined;
  }

  private splitTopLevelByComma(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';

    for (const character of text) {
      if (character === '(' || character === '<' || character === '[') depth += 1;
      else if (character === ')' || character === '>' || character === ']') depth -= 1;

      if (character === ',' && depth <= 0) {
        parts.push(current);
        current = '';
      } else {
        current += character;
      }
    }
    if (current.trim()) parts.push(current);

    return parts;
  }

  private extractRecordComponents(componentString: string, lineNumber: number): JavaField[] {
    const fields: JavaField[] = [];

    for (const rawPart of this.splitTopLevelByComma(componentString)) {
      let part = rawPart.trim();
      if (!part) continue;

      const annotations: string[] = [];
      let annotationMatch: RegExpMatchArray | null;
      while ((annotationMatch = part.match(/^@(\w+)(?:\([^()]*\))?\s*/))) {
        annotations.push(annotationMatch[1]);
        part = part.slice(annotationMatch[0].length);
      }

      const tokens = part.split(/\s+/).filter(Boolean);
      if (tokens.length >= 2) {
        const name = tokens[tokens.length - 1];
        const type = tokens.slice(0, -1).join(' ');
        fields.push({
          name,
          type,
          modifiers: ['final'],
          annotations,
          isStatic: false,
          isFinal: true,
          lineNumber
        });
      }
    }

    return fields;
  }

  private extractInterfaces(content: string, filePath: string): JavaInterface[] {
    const interfaces: JavaInterface[] = [];
    const lines = content.split('\n');
    const structuralLines = maskCStyleComments(content).split('\n');
    const packageName = this.extractPackage(content) || 'default';

    for (let i = 0; i < lines.length; i++) {
      const line = structuralLines[i].trim();

      if (line.includes('interface ') && !line.startsWith('//')) {
        const interfaceMatch = line.match(/\b(public|private|protected|\s)*\s*interface\s+(\w+)/);

        if (interfaceMatch) {
          const interfaceName = interfaceMatch[2];
          const extendsMatch = line.match(/extends\s+([^{]+)/);

          const extendsInterfaces: string[] = extendsMatch
            ? extendsMatch[1].split(',').map(s => s.trim())
            : [];

          const interfaceStartLine = i + 1;
          const interfaceEndLine = this.findClassEnd(structuralLines, i);

          const methods = this.extractMethods(lines, i, interfaceEndLine);
          const fields = this.extractFields(lines, i, interfaceEndLine);
          const annotations = this.extractAnnotations(lines, i);

          interfaces.push({
            name: interfaceName,
            packageName,
            filePath,
            extends: extendsInterfaces,
            methods,
            fields,
            annotations,
            lineStart: interfaceStartLine,
            lineEnd: interfaceEndLine
          });
        }
      }
    }

    return interfaces;
  }

  private extractMethods(lines: string[], classStart: number, classEnd: number): JavaMethod[] {
    const methods: JavaMethod[] = [];
    let braceDepth = 0;

    for (let i = classStart; i < classEnd; i++) {
      const firstLine = lines[i].trim();
      const signatureText = firstLine && braceDepth === 1
        ? this.joinSignatureLines(lines, i)
        : '';

      if (this.isMethodDeclaration(signatureText)) {
        const methodMatch = signatureText.match(/\b(\w+)\s*\(/);
        if (methodMatch) {
          const methodName = methodMatch[1];
          const modifiers = this.extractModifiers(signatureText);
          const returnType = this.extractReturnType(signatureText);
          const parameters = this.extractParameters(signatureText);
          const annotations = this.extractAnnotations(lines, i);

          const throwsMatch = signatureText.match(/throws\s+([^{;]+)/);
          const throwsExceptions = throwsMatch
            ? throwsMatch[1].split(',').map(s => s.trim()).filter(s => s.length > 0)
            : [];

          const methodEndLine = this.findMethodEnd(lines, i);

          methods.push({
            name: methodName,
            returnType,
            parameters,
            modifiers,
            annotations,
            throwsExceptions,
            lineStart: i + 1,
            lineEnd: methodEndLine,
            isConstructor: returnType === '',
            isAbstract: modifiers.includes('abstract'),
            isStatic: modifiers.includes('static')
          });
        }
      }
      braceDepth += this.javaBraceDelta(lines[i]);
    }

    return methods;
  }

  private extractThrownTypes(lines: string[], bodyStart: number, bodyEnd: number): string[] {
    const types = new Set<string>();
    const from = Math.max(0, bodyStart - 1);
    const to = Math.min(lines.length - 1, bodyEnd - 1);

    const throwNew = /\bthrow\s+new\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*[(<]/g;
    for (let i = from; i <= to; i++) {
      const line = lines[i];
      let m: RegExpExecArray | null;
      throwNew.lastIndex = 0;
      while ((m = throwNew.exec(line)) !== null) {
        const parts = m[1].split('.');
        const simple = parts[parts.length - 1];
        if (simple) types.add(simple);
      }
    }
    return Array.from(types);
  }

  private buildSignatureThrows(
    declared: string[] | undefined,
    documentation: CASDocumentation | undefined,
    thrown: string[] | undefined
  ): string[] | undefined {
    const types = new Set<string>();
    for (const t of declared || []) {

      const trimmed = t?.trim();
      if (trimmed) types.add(trimmed);
    }
    for (const d of documentation?.throws || []) {
      if (d?.type) types.add(d.type);
    }
    for (const t of thrown || []) {
      if (t) types.add(t);
    }
    return types.size > 0 ? Array.from(types) : undefined;
  }

  private extractFields(lines: string[], classStart: number, classEnd: number): JavaField[] {
    const fields: JavaField[] = [];

    for (let i = classStart; i < classEnd; i++) {
      const line = lines[i].trim();

      if (this.isFieldDeclaration(line)) {
        const fieldMatch = line.match(/(\w+)\s*[=;]/);
        if (fieldMatch) {
          const fieldName = fieldMatch[1];
          const modifiers = this.extractModifiers(line);
          const type = this.extractFieldType(line);
          const annotations = this.extractAnnotations(lines, i);
          const initialValueMatch = line.match(/=\s*([^;]+)/);

          fields.push({
            name: fieldName,
            type,
            modifiers,
            annotations,
            initialValue: initialValueMatch ? initialValueMatch[1].trim() : undefined,
            isStatic: modifiers.includes('static'),
            isFinal: modifiers.includes('final'),
            lineNumber: i + 1
          });
        }
      }
    }

    return fields;
  }

  private isMethodDeclaration(line: string): boolean {
    const trimmed = line
      .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""')
      .trim();

    if (!trimmed || /^[{}\]),;]/.test(trimmed)) return false;

    if (/^(?:throw|return|if|else|for|while|switch|do|try|catch|finally|synchronized|assert|new|super|this)\b/.test(trimmed)) {
      return false;
    }

    if (trimmed.startsWith('.')) return false;

    if (!trimmed.includes('(') || !trimmed.includes(')')) {
      return false;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('@')) {
      return false;
    }

    if (/\b(?:if|while|for|switch|catch)\s*\(/.test(trimmed)) {
      return false;
    }

    const assignmentIndex = trimmed.indexOf('=');
    const parameterIndex = trimmed.indexOf('(');
    if (assignmentIndex !== -1 && assignmentIndex < parameterIndex) return false;

    const hasModifier = /\b(?:public|private|protected|static|final|abstract|synchronized|native|default)\b/.test(trimmed);
    const hasVoid = /\bvoid\s+\w+\s*\(/.test(trimmed);
    const hasTypeName = /\b[A-Za-z_$][\w$]*(?:\s*<[^;{()]*>)?(?:\s*\[\s*\])*\s+[A-Za-z_$][\w$]*\s*\(/.test(trimmed);

    return hasModifier || hasVoid || hasTypeName;
  }

  private javaBraceDelta(line: string): number {
    const structural = line
      .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '')
      .replace(/\/\/.*$/, '');
    let delta = 0;
    for (const character of structural) {
      if (character === '{') delta++;
      else if (character === '}') delta--;
    }
    return delta;
  }

  private joinSignatureLines(lines: string[], startIndex: number, maxLookahead = 8): string {
    let joined = lines[startIndex];

    if (/[{;]/.test(joined)) {
      const cut = joined.search(/[{;]/);
      return joined.slice(0, cut + 1);
    }
    const limit = Math.min(lines.length - 1, startIndex + maxLookahead);
    for (let j = startIndex + 1; j <= limit; j++) {
      const next = lines[j];
      const cut = next.search(/[{;]/);
      if (cut !== -1) {
        joined += ' ' + next.slice(0, cut + 1);
        return joined;
      }
      joined += ' ' + next;
    }
    return joined;
  }

  private isFieldDeclaration(line: string): boolean {
    return (line.includes('=') || line.endsWith(';')) &&
           !line.includes('(') && !line.includes('return') &&
           !line.startsWith('//') && !line.includes('if') &&
           (line.includes('private') || line.includes('public') ||
            line.includes('protected') || !!line.match(/\w+\s+\w+\s*[=;]/));
  }

  private extractModifiers(line: string): string[] {
    const modifiers: string[] = [];
    const modifierKeywords = ['public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized', 'volatile', 'transient'];

    for (const keyword of modifierKeywords) {
      if (line.includes(keyword)) {
        modifiers.push(keyword);
      }
    }

    return modifiers;
  }

  private extractReturnType(line: string): string {
    const parts = line.trim().split(/\s+/);
    let returnTypeIndex = -1;

    for (let i = 0; i < parts.length; i++) {
      if (parts[i].includes('(')) {
        returnTypeIndex = i - 1;
        break;
      }
    }

    return returnTypeIndex > 0 ? parts[returnTypeIndex] : '';
  }

  private extractFieldType(line: string): string {
    const parts = line.trim().split(/\s+/);

    for (let i = 0; i < parts.length; i++) {
      if (!['public', 'private', 'protected', 'static', 'final', 'volatile', 'transient'].includes(parts[i])) {
        return parts[i];
      }
    }

    return 'Object';
  }

  private extractParameters(line: string): JavaParameter[] {
    const parameters: JavaParameter[] = [];
    const paramMatch = line.match(/\((.*?)\)/);

    if (paramMatch && paramMatch[1].trim()) {
      const paramString = paramMatch[1];
      const params = paramString.split(',');

      for (const param of params) {
        const trimmed = param.trim();
        const parts = trimmed.split(/\s+/);

        if (parts.length >= 2) {
          const type = parts[parts.length - 2];
          const name = parts[parts.length - 1];
          const isFinal = parts.includes('final');

          parameters.push({
            name,
            type,
            annotations: [],
            isFinal
          });
        }
      }
    }

    return parameters;
  }

  private extractAnnotations(lines: string[], lineIndex: number): string[] {
    const annotations: string[] = [];

    for (let i = lineIndex - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('@')) {
        const annotationMatch = line.match(/@(\w+)/);
        if (annotationMatch) {
          annotations.unshift(annotationMatch[1]);
        }
      } else if (line && !line.startsWith('//')) {
        break;
      }
    }

    return annotations;
  }

  private extractJavaDoc(lines: string[], lineIndex: number): CASDocumentation | undefined {
    let javadocStart = -1;
    let javadocEnd = -1;

    for (let i = lineIndex - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line === '*/') {
        javadocEnd = i;
      } else if (line.startsWith('/**')) {
        javadocStart = i;
        break;
      } else if (line && !line.startsWith('*') && !line.startsWith('//') && javadocEnd === -1) {
        break;
      }
    }

    if (javadocStart === -1 || javadocEnd === -1) {
      return undefined;
    }

    const javadocLines = lines.slice(javadocStart, javadocEnd + 1);
    const rawDoc = javadocLines.join('\n');
    const cleanedLines = javadocLines
      .map(line => line.trim())
      .map(line => line.replace(/^\/\*\*/, '').replace(/^\*\//, '').replace(/^\*/, '').trim())
      .filter(line => line.length > 0);

    if (cleanedLines.length === 0) {
      return undefined;
    }

    const parameters: Array<{ name: string; type?: string; description?: string; optional?: boolean; default_value?: string }> = [];
    const throws: Array<{ type?: string; description?: string }> = [];
    const tags: Array<{ tag: string; value: string; metadata?: Record<string, any> }> = [];
    let summary = '';
    let description = '';
    let returns: { type?: string; description?: string } | undefined;

    let currentSection = 'description';
    const descriptionLines: string[] = [];

    for (const line of cleanedLines) {
      if (line.startsWith('@param')) {
        currentSection = 'param';
        const paramMatch = line.match(/@param\s+(\{([^}]+)\})?\s*(\w+)\s*(.*)/);
        if (paramMatch) {
          parameters.push({
            name: paramMatch[3],
            type: paramMatch[2],
            description: paramMatch[4]?.trim() || undefined
          });
        }
      } else if (line.startsWith('@return')) {
        currentSection = 'return';
        const returnMatch = line.match(/@return\s+(\{([^}]+)\})?\s*(.*)/);
        if (returnMatch) {
          returns = {
            type: returnMatch[2],
            description: returnMatch[3]?.trim() || undefined
          };
        }
      } else if (line.startsWith('@throws') || line.startsWith('@exception')) {
        currentSection = 'throws';
        const throwsMatch = line.match(/@(?:throws|exception)\s+(\w+)\s*(.*)/);
        if (throwsMatch) {
          throws.push({
            type: throwsMatch[1],
            description: throwsMatch[2]?.trim() || undefined
          });
        }
      } else if (line.startsWith('@deprecated')) {
        const deprecatedMatch = line.match(/@deprecated\s*(.*)/);
        tags.push({
          tag: '@deprecated',
          value: deprecatedMatch?.[1]?.trim() || 'true'
        });
      } else if (line.startsWith('@since')) {
        const sinceMatch = line.match(/@since\s*(.*)/);
        if (sinceMatch) {
          tags.push({
            tag: '@since',
            value: sinceMatch[1].trim()
          });
        }
      } else if (line.startsWith('@author')) {
        const authorMatch = line.match(/@author\s*(.*)/);
        if (authorMatch) {
          tags.push({
            tag: '@author',
            value: authorMatch[1].trim()
          });
        }
      } else if (line.startsWith('@see')) {
        const seeMatch = line.match(/@see\s*(.*)/);
        if (seeMatch) {
          tags.push({
            tag: '@see',
            value: seeMatch[1].trim()
          });
        }
      } else if (line.startsWith('@')) {
        const tagMatch = line.match(/@(\w+)\s*(.*)/);
        if (tagMatch) {
          tags.push({
            tag: `@${tagMatch[1]}`,
            value: tagMatch[2]?.trim() || ''
          });
        }
      } else {
        if (currentSection === 'description') {
          descriptionLines.push(line);
        }
      }
    }

    if (descriptionLines.length > 0) {
      summary = descriptionLines[0];
      if (descriptionLines.length > 1) {
        description = descriptionLines.slice(1).join(' ').trim();
      }
    }

    return {
      type: 'javadoc',
      raw: rawDoc,
      summary: summary || undefined,
      description: description || undefined,
      parameters: parameters.length > 0 ? parameters : undefined,
      returns,
      throws: throws.length > 0 ? throws : undefined,
      tags: tags.length > 0 ? tags : undefined,
      location: {
        start_line: javadocStart + 1,
        end_line: javadocEnd + 1
      }
    };
  }

  private extractComments(content: string, filePath: string): CASComment[] {
    const comments: CASComment[] = [];
    const lines = content.split('\n');
    let commentId = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const singleLineMatch = line.match(/\/\/\s*(.*)/);
      if (singleLineMatch) {
        const commentText = singleLineMatch[1].trim();
        if (commentText) {
          comments.push({
            id: `comment_${filePath}_${++commentId}`,
            type: 'single-line',
            style: '//',
            text: commentText,
            purpose: this.classifyCommentPurpose(commentText),
            location: {
              file: filePath,
              line: i + 1,
              relative_to: 'inline'
            },
            markers: this.extractCommentMarkers(commentText)
          });
        }
      }

      const multiLineStart = line.indexOf('/*');
      if (multiLineStart !== -1 && !line.includes('/**')) {
        let endLine = i;
        let multiLineContent = line.substring(multiLineStart + 2);

        const sameLineEnd = multiLineContent.indexOf('*/');
        if (sameLineEnd !== -1) {
          multiLineContent = multiLineContent.substring(0, sameLineEnd);
        } else {
          for (let j = i + 1; j < lines.length; j++) {
            const nextLine = lines[j];
            const endIndex = nextLine.indexOf('*/');
            if (endIndex !== -1) {
              multiLineContent += '\n' + nextLine.substring(0, endIndex);
              endLine = j;
              break;
            } else {
              multiLineContent += '\n' + nextLine;
            }
          }
        }

        const cleanedText = multiLineContent.trim();
        if (cleanedText) {
          comments.push({
            id: `comment_${filePath}_${++commentId}`,
            type: 'multi-line',
            style: '/* */',
            text: cleanedText,
            purpose: this.classifyCommentPurpose(cleanedText),
            location: {
              file: filePath,
              line: i + 1,
              relative_to: endLine > i ? 'above' : 'inline'
            },
            markers: this.extractCommentMarkers(cleanedText)
          });
        }
      }
    }

    return comments;
  }

  private classifyCommentPurpose(text: string): 'explanation' | 'todo' | 'warning' | 'note' | 'hack' | 'clarification' | 'disabled-code' | 'other' {
    const lowerText = text.toLowerCase();

    if (lowerText.includes('todo') || lowerText.includes('fixme') || lowerText.includes('xxx')) {
      return 'todo';
    }
    if (lowerText.includes('warning') || lowerText.includes('caution') || lowerText.includes('danger')) {
      return 'warning';
    }
    if (lowerText.includes('hack') || lowerText.includes('workaround') || lowerText.includes('temporary')) {
      return 'hack';
    }
    if (lowerText.includes('note') || lowerText.includes('nb:') || lowerText.includes('important')) {
      return 'note';
    }
    if (text.trim().match(/^\s*\/\/\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\(.*\)/) ||
        text.includes('return') || text.includes('if (') || text.includes('for (')) {
      return 'disabled-code';
    }

    return 'explanation';
  }

  private extractCommentMarkers(text: string): CASComment['markers'] {
    const lowerText = text.toLowerCase();

    return {
      is_todo: lowerText.includes('todo'),
      is_fixme: lowerText.includes('fixme'),
      is_hack: lowerText.includes('hack') || lowerText.includes('workaround'),
      is_warning: lowerText.includes('warning') || lowerText.includes('caution'),
      is_note: lowerText.includes('note') || lowerText.includes('nb:'),
      is_question: lowerText.includes('?') || lowerText.includes('why'),
      is_important: lowerText.includes('important') || lowerText.includes('!!!'),
      custom_markers: this.extractCustomMarkers(text)
    };
  }

  private extractCustomMarkers(text: string): string[] {
    const markers: string[] = [];
    const customPatterns = [
      /\b(OPTIMIZE|REFACTOR|REVIEW|PERFORMANCE)\b/gi,
      /\b(BUG|ISSUE|PROBLEM)\b/gi,
      /\b(SECURITY|VULNERABILITY)\b/gi
    ];

    for (const pattern of customPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        markers.push(...matches.map(m => m.toUpperCase()));
      }
    }

    return Array.from(new Set(markers));
  }

  private extractTodos(content: string, filePath: string): CASTodo[] {
    const todos: CASTodo[] = [];
    const lines = content.split('\n');
    let todoId = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      const todoPatterns = [
        { pattern: /\/\/\s*TODO(?:\(([^)]+)\))?\s*:?\s*(.*)/i, type: 'TODO' as const },
        { pattern: /\/\/\s*FIXME(?:\(([^)]+)\))?\s*:?\s*(.*)/i, type: 'FIXME' as const },
        { pattern: /\/\/\s*XXX(?:\(([^)]+)\))?\s*:?\s*(.*)/i, type: 'XXX' as const },
        { pattern: /\/\/\s*HACK(?:\(([^)]+)\))?\s*:?\s*(.*)/i, type: 'HACK' as const },
        { pattern: /\/\/\s*NOTE(?:\(([^)]+)\))?\s*:?\s*(.*)/i, type: 'NOTE' as const },
        { pattern: /\/\/\s*WARNING(?:\(([^)]+)\))?\s*:?\s*(.*)/i, type: 'WARNING' as const },
        { pattern: /\/\/\s*OPTIMIZE(?:\(([^)]+)\))?\s*:?\s*(.*)/i, type: 'OPTIMIZE' as const },
        { pattern: /\/\/\s*REFACTOR(?:\(([^)]+)\))?\s*:?\s*(.*)/i, type: 'REFACTOR' as const }
      ];

      for (const { pattern, type } of todoPatterns) {
        const match = trimmedLine.match(pattern);
        if (match) {
          const assignee = match[1];
          const text = match[2]?.trim() || '';

          if (text) {
            const priority = this.determineTodoPriority(type, text);
            const category = this.categorizeTodo(type, text);

            todos.push({
              id: `todo_${filePath}_${++todoId}`,
              type,
              text,
              priority,
              assignee: assignee || undefined,
              location: {
                file: filePath,
                line: i + 1
              },
              classification: {
                category,
                technical_debt: ['TODO', 'FIXME', 'HACK', 'REFACTOR'].includes(type),
                blocking: this.isTodoBlocking(text)
              }
            });
          }
          break;
        }
      }

      const multiLineTodoStart = trimmedLine.match(/\/\*\s*(TODO|FIXME|XXX|HACK|NOTE|WARNING|OPTIMIZE|REFACTOR)(?:\(([^)]+)\))?\s*:?\s*(.*)/i);
      if (multiLineTodoStart) {
        const type = multiLineTodoStart[1].toUpperCase() as CASTodo['type'];
        const assignee = multiLineTodoStart[2];
        let todoText = multiLineTodoStart[3] || '';

        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j].trim();
          if (nextLine.includes('*/')) {
            const endContent = nextLine.substring(0, nextLine.indexOf('*/')).trim();
            if (endContent) {
              todoText += ' ' + endContent;
            }
            break;
          } else {
            todoText += ' ' + nextLine.replace(/^\*\s*/, '').trim();
          }
        }

        if (todoText.trim()) {
          const priority = this.determineTodoPriority(type, todoText);
          const category = this.categorizeTodo(type, todoText);

          todos.push({
            id: `todo_${filePath}_${++todoId}`,
            type,
            text: todoText.trim(),
            priority,
            assignee: assignee || undefined,
            location: {
              file: filePath,
              line: i + 1
            },
            classification: {
              category,
              technical_debt: ['TODO', 'FIXME', 'HACK', 'REFACTOR'].includes(type),
              blocking: this.isTodoBlocking(todoText)
            }
          });
        }
      }
    }

    return todos;
  }

  private determineTodoPriority(type: CASTodo['type'], text: string): 'low' | 'medium' | 'high' | 'critical' {
    const lowerText = text.toLowerCase();

    if (type === 'FIXME' || lowerText.includes('critical') || lowerText.includes('urgent') || lowerText.includes('asap')) {
      return 'critical';
    }
    if (type === 'XXX' || lowerText.includes('important') || lowerText.includes('security') || lowerText.includes('bug')) {
      return 'high';
    }
    if (type === 'TODO' || type === 'REFACTOR' || type === 'OPTIMIZE') {
      return 'medium';
    }

    return 'low';
  }

  private categorizeTodo(type: CASTodo['type'], text: string): 'bug' | 'feature' | 'refactor' | 'performance' | 'security' | 'documentation' | 'test' {
    const lowerText = text.toLowerCase();

    if (type === 'FIXME' || lowerText.includes('bug') || lowerText.includes('error') || lowerText.includes('broken')) {
      return 'bug';
    }
    if (lowerText.includes('security') || lowerText.includes('vulnerability') || lowerText.includes('auth')) {
      return 'security';
    }
    if (type === 'OPTIMIZE' || lowerText.includes('performance') || lowerText.includes('slow') || lowerText.includes('memory')) {
      return 'performance';
    }
    if (type === 'REFACTOR' || lowerText.includes('refactor') || lowerText.includes('cleanup') || lowerText.includes('restructure')) {
      return 'refactor';
    }
    if (lowerText.includes('test') || lowerText.includes('coverage') || lowerText.includes('assertion')) {
      return 'test';
    }
    if (lowerText.includes('document') || lowerText.includes('comment') || lowerText.includes('javadoc')) {
      return 'documentation';
    }

    return 'feature';
  }

  private isTodoBlocking(text: string): boolean {
    const lowerText = text.toLowerCase();
    return lowerText.includes('blocking') ||
           lowerText.includes('critical') ||
           lowerText.includes('must fix') ||
           lowerText.includes('broken') ||
           lowerText.includes('prevents');
  }

  private analyzeImplementationStatus(lines: string[], startIndex: number, endIndex: number, annotations: string[]): CASImplementationStatus {
    const methodLines = lines.slice(startIndex, endIndex);
    const methodContent = methodLines.join('\n').toLowerCase();

    const indicators = {
      has_todo_markers: methodContent.includes('todo') || methodContent.includes('fixme') || methodContent.includes('xxx'),
      has_not_implemented_exceptions: methodContent.includes('unsupportedoperationexception') ||
                                      methodContent.includes('notimplementedexception') ||
                                      methodContent.includes('throw new unsupportedoperationexception'),
      has_stub_returns: this.hasStubReturns(methodLines),
      has_placeholder_code: this.hasPlaceholderCode(methodContent),
      has_hardcoded_values: this.hasHardcodedValues(methodContent),
      has_commented_out_code: this.hasCommentedOutCode(methodLines)
    };

    let status: CASImplementationStatus['status'] = 'complete';

    if (annotations.includes('Deprecated')) {
      status = 'deprecated';
    } else if (this.isExperimentalCode(methodContent, annotations)) {
      status = 'experimental';
    } else if (indicators.has_not_implemented_exceptions) {
      status = 'not-implemented';
    } else if (this.isStubMethod(methodLines)) {
      status = 'stub';
    } else if (indicators.has_todo_markers || indicators.has_placeholder_code) {
      status = 'partial';
    }

    const implementationStatus: CASImplementationStatus = {
      status,
      indicators
    };

    if (status === 'deprecated') {
      implementationStatus.deprecation = {
        is_deprecated: true,
        deprecated_since: this.extractDeprecatedSince(lines, startIndex),
        replacement: this.extractDeprecationReplacement(lines, startIndex)
      };
    }

    if (status === 'experimental') {
      implementationStatus.experimental = {
        is_experimental: true,
        stability_level: this.determineStabilityLevel(methodContent, annotations)
      };
    }

    return implementationStatus;
  }

  private hasStubReturns(methodLines: string[]): boolean {
    const content = methodLines.join(' ').toLowerCase();
    return content.includes('return null') ||
           content.includes('return 0') ||
           content.includes('return false') ||
           content.includes('return ""') ||
           content.includes('return new') && content.includes('()') ||
           /return\s+[a-z_][a-z0-9_]*\s*;/.test(content);
  }

  private hasPlaceholderCode(content: string): boolean {
    return content.includes('placeholder') ||
           content.includes('implement me') ||
           content.includes('fill in') ||
           content.includes('add implementation') ||
           content.includes('stub') ||
           /\/\/\s*implement/.test(content);
  }

  private hasHardcodedValues(content: string): boolean {
    const hardcodedPatterns = [
      /"[^"]*localhost[^"]*"/,
      /"[^"]*127\.0\.0\.1[^"]*"/,
      /"[^"]*test[^"]*"/,
      /"[^"]*example[^"]*"/,
      /\b(true|false)\s*;/,
      /\b\d{4,}\b/
    ];

    return hardcodedPatterns.some(pattern => pattern.test(content));
  }

  private hasCommentedOutCode(methodLines: string[]): boolean {
    const commentedCodePatterns = [
      /\/\/\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\(/,
      /\/\/\s*return\s+/,
      /\/\/\s*if\s*\(/,
      /\/\/\s*for\s*\(/,
      /\/\/\s*while\s*\(/,
      /\/\/\s*try\s*\{/
    ];

    return methodLines.some(line =>
      commentedCodePatterns.some(pattern => pattern.test(line))
    );
  }

  private isExperimentalCode(content: string, annotations: string[]): boolean {
    return annotations.includes('Experimental') ||
           annotations.includes('Beta') ||
           content.includes('experimental') ||
           content.includes('alpha') ||
           content.includes('beta');
  }

  private isStubMethod(methodLines: string[]): boolean {
    const nonEmptyLines = methodLines
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('//') && !line.startsWith('/*'));

    if (nonEmptyLines.length <= 3) {
      const content = nonEmptyLines.join(' ').toLowerCase();
      return content.includes('throw new unsupportedoperationexception') ||
             content.includes('return null') ||
             content.includes('return false') ||
             content.includes('return 0') ||
             content.includes('return ""');
    }

    return false;
  }

  private extractDeprecatedSince(lines: string[], lineIndex: number): string | undefined {
    for (let i = lineIndex - 10; i < lineIndex; i++) {
      if (i >= 0 && i < lines.length) {
        const line = lines[i];
        const sinceMatch = line.match(/@since\s+([\d.]+)/);
        if (sinceMatch) {
          return sinceMatch[1];
        }
        const deprecatedMatch = line.match(/@deprecated.*since\s+([\d.]+)/i);
        if (deprecatedMatch) {
          return deprecatedMatch[1];
        }
      }
    }
    return undefined;
  }

  private extractDeprecationReplacement(lines: string[], lineIndex: number): string | undefined {
    for (let i = lineIndex - 10; i < lineIndex; i++) {
      if (i >= 0 && i < lines.length) {
        const line = lines[i];
        const replacementMatch = line.match(/@deprecated.*use\s+([a-zA-Z_][a-zA-Z0-9_.]*)/i);
        if (replacementMatch) {
          return replacementMatch[1];
        }
        const seeMatch = line.match(/@see\s+([a-zA-Z_][a-zA-Z0-9_.#]*)/);
        if (seeMatch) {
          return seeMatch[1];
        }
      }
    }
    return undefined;
  }

  private determineStabilityLevel(content: string, annotations: string[]): 'unstable' | 'experimental' | 'beta' | 'stable' {
    if (annotations.includes('Beta') || content.includes('beta')) {
      return 'beta';
    }
    if (annotations.includes('Experimental') || content.includes('experimental')) {
      return 'experimental';
    }
    if (content.includes('alpha') || content.includes('unstable')) {
      return 'unstable';
    }
    return 'stable';
  }

  private findClassEnd(lines: string[], startIndex: number): number {
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

    let braceCount = 0;
    let foundOpenBrace = false;

    for (let i = startIndex; i < lines.length; i++) {
      const currentLine = lines[i];

      for (const char of currentLine) {
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

    return startIndex + 1;
  }

  private buildPackageHierarchy(packages: Map<string, string[]>, nodes: CASNode[], edges: CASEdge[]): void {
    for (const [packageName, files] of Array.from(packages.entries())) {
      const packageId = `package_${this.sanitizeId(packageName)}`;

      nodes.push(this.createNode(
        packageId,
        packageName,
        'package',
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
          `${packageId}_contains_${fileId}`,
          packageId,
          fileId,
          'contains'
        ));
      }
    }
  }

  private detectSpringPatterns(nodes: CASNode[], _edges: CASEdge[], entryPoints: any[]): void {
    if (!this.springFrameworkDetected) return;

    const springAnnotations = ['Controller', 'RestController', 'Service', 'Repository', 'Component'];

    for (const node of nodes) {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'class' && node.metadata?.annotations) {
        const annotations = node.metadata.annotations as string[];
        const springAnnotation = annotations.find(a => springAnnotations.includes(a));

        if (springAnnotation) {
          if (!node.metadata.attributes) {
            node.metadata.attributes = {};
          }
          node.metadata.attributes.springComponent = springAnnotation;

          if (['Controller', 'RestController'].includes(springAnnotation)) {
            entryPoints.push({
              id: `entry_spring_${node.id}`,
              name: `Spring ${springAnnotation}: ${node.name}`,
              type: 'spring_controller',
              source_node: node.id,
              metadata: {
                annotation: springAnnotation,
                className: node.name
              }
            });
          }
        }
      }
    }
  }

  private buildInheritanceRelationships(nodes: CASNode[], edges: CASEdge[]): void {
    const classNodes = nodes.filter(n => n.type === 'class');

    for (const classNode of classNodes) {
      if (classNode.metadata?.attributes?.extends) {
        const superClassName = classNode.metadata.attributes.extends as string;
        const superClassNode = classNodes.find(n => n.name === superClassName);

        if (superClassNode) {
          edges.push(this.createEdge(
            `${classNode.id}_extends_${superClassNode.id}`,
            classNode.id,
            superClassNode.id,
            'extends'
          ));
        }
      }

      if (classNode.metadata?.attributes?.implementsInterfaces) {
        const implementedInterfaces = classNode.metadata.attributes.implementsInterfaces as string[];
        for (const interfaceName of implementedInterfaces) {
          const interfaceNode = nodes.find(n => n.type === 'interface' && n.name === interfaceName);

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
    }
  }

  private extractXmlValue(content: string, tagName: string): string | null {
    const regex = new RegExp(`<${tagName}>(.*?)</${tagName}>`, 's');
    const match = content.match(regex);
    return match ? match[1].trim() : null;
  }

  private buildJavaReceiverTypeMap(content: string, startLine?: number, endLine?: number): Map<string, string> {
    const map = new Map<string, string>();
    if (!content || !startLine) return map;
    const lines = content.split('\n');
    const text = lines.slice(startLine - 1, (endLine && endLine >= startLine) ? endLine : startLine).join('\n');
    const bare = (t: string) => t.replace(/<.*$/, '').replace(/\[\]/g, '').replace(/\.\.\.$/, '').trim().split('.').pop() || t;

    const header = text.split('{')[0];
    const pm = header.match(/\(([^)]*)\)/);
    if (pm && pm[1].trim()) {
      for (const part of pm[1].split(',')) {
        const toks = part.trim().replace(/\bfinal\b/g, '').trim().split(/\s+/).filter(Boolean);
        if (toks.length >= 2) {
          const name = toks[toks.length - 1];
          const type = bare(toks[toks.length - 2]);
          if (/^[A-Z]/.test(type)) map.set(name, type);
        }
      }
    }

    for (const m of text.matchAll(/\b([A-Z][A-Za-z0-9_]*)(?:<[^>]*>)?(?:\[\])?\s+([a-z_]\w*)\s*[=;]/g)) map.set(m[2], bare(m[1]));
    for (const m of text.matchAll(/\bvar\s+(\w+)\s*=\s*new\s+([A-Z][A-Za-z0-9_]*)/g)) map.set(m[1], bare(m[2]));
    return map;
  }

  private async analyzeCallGraph(
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[]
  ): Promise<void> {
    const javaFiles = await glob(['**/*.java'], {
      cwd: projectPath,
      ignore: this.getJavaIgnorePatterns({ projectPath }),
      nodir: true
    });
    javaFiles.sort();

    const methodNodes = nodes.filter(n => n.type === 'method' || n.type === 'interface_method');
    const classNodes = nodes.filter(n => n.type === 'class' || n.type === 'interface');

    for (const file of javaFiles) {
      const fullPath = `${projectPath}/${file}`;
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');
      const packageName = this.extractPackage(content) || 'default';

      const varTypeCache = new Map<string, Map<string, string>>();

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const methodCalls = [
          ...Array.from(line.matchAll(/(\w+)\.(\w+)\s*\(/g)),
          ...Array.from(line.matchAll(/new\s+(\w+)\s*\(/g)).map(m => [m[0], m[1], m[1]]),
          ...Array.from(line.matchAll(/(\w+)::(\w+)/g)),
          ...Array.from(line.matchAll(/super\.(\w+)\s*\(/g)).map(m => [m[0], 'super', m[1]]),
          ...Array.from(line.matchAll(/this\.(\w+)\s*\(/g)).map(m => [m[0], 'this', m[1]])
        ];

        for (const match of methodCalls) {
          const fullMatch = match[0];
          const objectOrClass = match[1];
          const methodName = match[2] || objectOrClass;

          const callerMethod = methodNodes.find(n =>
            n.source?.file === file &&
            n.source?.line !== undefined && n.source.line <= i + 1 &&
            n.source?.end_line !== undefined && n.source.end_line >= i + 1
          );

          if (callerMethod) {
            let targetMethod: CASNode | undefined;

            if (objectOrClass === 'this' || objectOrClass === 'super') {
              const containingClass = classNodes.find(c =>
                edges.some(e => e.source === c.id && e.target === callerMethod.id && e.type === 'has_method')
              );

              if (containingClass) {
                const className = objectOrClass === 'super' && containingClass.metadata?.attributes?.extends
                  ? containingClass.metadata.attributes.extends
                  : containingClass.name;

                targetMethod = methodNodes.find(n => {
                  const parentClass = classNodes.find(c =>
                    c.name === className &&
                    edges.some(e => e.source === c.id && e.target === n.id && e.type === 'has_method')
                  );
                  return parentClass && n.name === methodName;
                });
              }
            } else if (fullMatch.startsWith('new ')) {
              const targetClass = classNodes.find(c => c.name === objectOrClass);
              if (targetClass) {
                targetMethod = methodNodes.find(n =>
                  n.name === objectOrClass &&
                  n.metadata?.attributes?.isConstructor &&
                  edges.some(e => e.source === targetClass.id && e.target === n.id && e.type === 'has_method')
                );
              }
            } else {

              let varTypes = varTypeCache.get(callerMethod.id);
              if (!varTypes) {
                varTypes = this.buildJavaReceiverTypeMap(content, callerMethod.source?.line, callerMethod.source?.end_line);
                varTypeCache.set(callerMethod.id, varTypes);
              }
              const recvType = varTypes.get(objectOrClass) || objectOrClass;
              const targetClass = classNodes.find(c => c.name === recvType);
              if (targetClass) {
                targetMethod = methodNodes.find(n =>
                  n.name === methodName &&
                  edges.some(e => e.source === targetClass.id && e.target === n.id && e.type === 'has_method')
                );
              }

              if (!targetMethod) {
                const named = methodNodes.filter(n => n.name === methodName);
                if (named.length === 1) targetMethod = named[0];
              }
            }

            if (targetMethod) {
              const callEdgeId = `call_${callerMethod.id}_to_${targetMethod.id}_${i}`;
              if (!edges.some(e => e.id === callEdgeId)) {
                edges.push(this.createEdge(
                  callEdgeId,
                  callerMethod.id,
                  targetMethod.id,
                  'calls',
                  'behavior',
                  {
                    line: i + 1,
                    callType: fullMatch.startsWith('new ') ? 'constructor' :
                             objectOrClass === 'super' ? 'super' :
                             objectOrClass === 'this' ? 'internal' : 'method'
                  }
                ));
              }
            } else if (this.isExternalLibraryCall(objectOrClass, methodName, packageName)) {
              exitPoints.push(this.createExitPoint(
                `exit_call_${callerMethod.id}_${objectOrClass}_${methodName}_${i}`,
                callerMethod.id,
                'sdk',
                `External call: ${objectOrClass}.${methodName}`,
                `Library call to ${this.identifyJavaLibrary(objectOrClass)}`,
                undefined,
                undefined,
                {
                  targetClass: objectOrClass,
                  targetMethod: methodName,
                  line: i + 1,
                  library: this.identifyJavaLibrary(objectOrClass)
                }
              ));
            }
          }
        }

        const springMappings = [
          ...Array.from(line.matchAll(/@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*\(\s*["']([^"']+)["']/g))
        ];

        for (const mapping of springMappings) {
          const mappingType = mapping[1];
          const methodPath = mapping[2];

          const nextMethodLine = this.findNextMethodDeclaration(lines, i);
          if (nextMethodLine !== -1) {
            const methodAtLine = methodNodes.find(n =>
              n.source?.file === file &&
              n.source?.line === nextMethodLine + 1
            );

            if (methodAtLine) {
              const containingClass = classNodes.find(node =>
                node.source?.file === file &&
                node.source?.line !== undefined && node.source.line <= nextMethodLine + 1 &&
                node.source?.end_line !== undefined && node.source.end_line >= nextMethodLine + 1
              );
              const classPath = containingClass?.source?.line
                ? findClassSpringMappingPath(lines, containingClass.source.line - 1)
                : '';
              const routePath = joinSpringRoutePaths(classPath, methodPath);
              const httpMethod = mappingType === 'RequestMapping'
                ? 'ALL'
                : mappingType.replace('Mapping', '').toUpperCase();
              const entryId = `entry_${methodAtLine.id}`;
              const existingEntry = entryPoints.find(entryPoint => entryPoint.id === entryId);
              const routeEntry: CASEntryPoint = {
                ...(existingEntry || {}),
                id: entryId,
                source_node: methodAtLine.id,
                type: 'http',
                name: `${httpMethod} ${routePath}`,
                description: `Spring HTTP endpoint: ${httpMethod} ${routePath}`,
                trigger: { method: httpMethod, path: routePath },
                handler: {
                  node_id: methodAtLine.id,
                  method_name: methodAtLine.name,
                  file,
                  line: methodAtLine.source?.line,
                },
                metadata: {
                  ...(existingEntry?.metadata || {}),
                  method: httpMethod.toLowerCase(),
                  path: routePath,
                  controller: containingClass?.name,
                  handler: methodAtLine.name,
                },
              };
              if (existingEntry) {
                entryPoints[entryPoints.indexOf(existingEntry)] = routeEntry;
              } else {
                entryPoints.push(routeEntry);
              }
              edges.push(this.createEdge(
                `http_endpoint_${methodAtLine.id}`,
                entryId,
                methodAtLine.id,
                'exposes',
                'behavior',
                {
                  httpMethod,
                  path: routePath,
                  annotation: `@${mappingType}`
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
      if (/\b(?:class|interface|enum|record)\s+[A-Za-z_$][\w$]*/.test(lines[i])) return -1;
      const firstLine = lines[i].trim();
      if (firstLine && this.isMethodDeclaration(this.joinSignatureLines(lines, i))) {
        return i;
      }
    }
    return -1;
  }

  private isExternalLibraryCall(objectOrClass: string, methodName: string, currentPackage: string): boolean {
    const javaLibraries = [
      'System', 'String', 'Integer', 'Double', 'Float', 'Long', 'Boolean',
      'Math', 'Arrays', 'Collections', 'List', 'Map', 'Set', 'HashMap', 'ArrayList',
      'File', 'Path', 'Files', 'IOException', 'Stream', 'Optional',
      'LocalDate', 'LocalDateTime', 'Instant', 'Duration',
      'Logger', 'LoggerFactory', 'Log'
    ];

    const springClasses = [
      'RestTemplate', 'WebClient', 'JdbcTemplate', 'RedisTemplate',
      'ApplicationContext', 'Environment', 'ResponseEntity'
    ];

    return javaLibraries.includes(objectOrClass) ||
           springClasses.includes(objectOrClass) ||
           (objectOrClass.startsWith('java.') ||
            objectOrClass.startsWith('javax.') ||
            objectOrClass.startsWith('org.springframework.') ||
            objectOrClass.startsWith('com.') && !objectOrClass.startsWith(currentPackage));
  }

  private identifyJavaLibrary(className: string): string {
    if (className.startsWith('java.lang')) return 'Java Core';
    if (className.startsWith('java.util')) return 'Java Utilities';
    if (className.startsWith('java.io') || className.startsWith('java.nio')) return 'Java I/O';
    if (className.startsWith('java.net')) return 'Java Networking';
    if (className.startsWith('java.sql') || className.startsWith('javax.sql')) return 'JDBC';
    if (className.startsWith('javax.servlet')) return 'Servlet API';
    if (className.startsWith('org.springframework')) return 'Spring Framework';
    if (className === 'Logger' || className === 'LoggerFactory') return 'SLF4J';

    const standardClasses: Record<string, string> = {
      'System': 'Java Core',
      'String': 'Java Core',
      'Math': 'Java Core',
      'Arrays': 'Java Utilities',
      'Collections': 'Java Utilities',
      'List': 'Java Collections',
      'Map': 'Java Collections',
      'Set': 'Java Collections',
      'HashMap': 'Java Collections',
      'ArrayList': 'Java Collections',
      'File': 'Java I/O',
      'Files': 'Java NIO',
      'Path': 'Java NIO',
      'Stream': 'Java Streams',
      'Optional': 'Java Utilities'
    };

    return standardClasses[className] || 'External Library';
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
      'method-mapping',
      'package-organization',
      'inheritance-tracking',
      'annotation-parsing',
      'spring-framework-detection',
      'javadoc-extraction',
      'comment-analysis',
      'todo-detection',
      'implementation-status-analysis',
      'deprecation-tracking',
      'experimental-code-detection',
      'technical-debt-analysis'
    ];
  }

  private applyTestFileBoundary(nodes: CASNode[]): void {
    for (const node of nodes) {
      const file = node.source?.file;
      if (!file || !this.isJavaTestPath(file)) continue;
      node.metadata = { ...node.metadata, is_test: true };
      node.category = 'test';
      node.subcategories = [...new Set([...(node.subcategories || []), node.type, 'test-code'])];
      node.tags = [...new Set([...(node.tags || []), 'test-code'])];
    }
  }

  private isJavaTestPath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    const basename = normalized.split('/').pop() || normalized;
    return /(?:^|\/)src\/test\/java\//i.test(normalized) ||
      /Tests?\.java$/i.test(basename);
  }
}
