import { BaseAnalyzer, AnalysisContext } from '../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint } from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import * as fs from 'fs-extra';
import { glob } from 'glob';

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
      'java-analyzer',
      'Java Language Analyzer',
      '1.0.0',
      'language'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const javaFiles = await glob(['**/*.java'], {
        cwd: projectPath,
        ignore: ['**/target/**', '**/build/**', '**/.git/**']
      });

      const buildFiles = await glob(['pom.xml', 'build.gradle', 'gradle.build'], {
        cwd: projectPath
      });

      return javaFiles.length > 0 || buildFiles.length > 0;
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
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
        ignore: ['**/target/**', '**/build/**', '**/.git/**', '**/test/**', '**/*Test.java']
      });

      const packages = new Map<string, string[]>();

      for (const file of javaFiles) {
        const fullPath = `${context.projectPath}/${file}`;
        await this.analyzeJavaFile(fullPath, file, nodes, edges, entryPoints, exitPoints, packages, context);
      }

      this.buildPackageHierarchy(packages, nodes, edges);
      this.detectSpringPatterns(nodes, edges, entryPoints);
      this.buildInheritanceRelationships(nodes, edges);

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
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

      for (const match of dependencyMatches) {
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
      const interfaces = this.extractInterfaces(content, relativePath);

      if (packageName) {
        if (!packages.has(packageName)) {
          packages.set(packageName, []);
        }
        packages.get(packageName)!.push(relativePath);
      }

      const fileId = `file_${this.sanitizeId(relativePath)}`;
      nodes.push(this.createNode(
        fileId,
        relativePath.split('/').pop() || 'unknown.java',
        'file',
        1,
        fullPath,
        1,
        lines.length,
        {
          packageName: packageName || 'default',
          imports: imports.map(i => i.importPath),
          classCount: classes.length,
          interfaceCount: interfaces.length
        }
      ));

      for (const imp of imports) {
        const importId = `import_${fileId}_${this.sanitizeId(imp.importPath)}`;
        nodes.push(this.createNode(
          importId,
          imp.importPath,
          'import',
          2,
          fullPath,
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
        await this.processJavaClass(cls, fileId, fullPath, nodes, edges, entryPoints);
      }

      for (const intf of interfaces) {
        await this.processJavaInterface(intf, fileId, fullPath, nodes, edges, entryPoints);
      }

    } catch (error) {
      console.warn(`Failed to analyze Java file ${relativePath}:`, error);
    }
  }

  private async processJavaClass(
    cls: JavaClass,
    fileId: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const classId = `class_${this.sanitizeId(cls.packageName)}_${this.sanitizeId(cls.name)}`;

    nodes.push(this.createNode(
      classId,
      cls.name,
      'class',
      2,
      fullPath,
      cls.lineStart,
      cls.lineEnd,
      {
        packageName: cls.packageName,
        modifiers: cls.modifiers,
        extends: cls.extends,
        implementsInterfaces: cls.implementsInterfaces,
        annotations: cls.annotations,
        fieldCount: cls.fields.length,
        methodCount: cls.methods.length,
        isPublic: cls.modifiers.includes('public'),
        isAbstract: cls.modifiers.includes('abstract'),
        isFinal: cls.modifiers.includes('final')
      }
    ));

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
        fullPath,
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
      nodes.push(this.createNode(
        methodId,
        method.name,
        'method',
        4,
        fullPath,
        method.lineStart,
        method.lineEnd,
        {
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
      ));

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
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const interfaceId = `interface_${this.sanitizeId(intf.packageName)}_${this.sanitizeId(intf.name)}`;

    nodes.push(this.createNode(
      interfaceId,
      intf.name,
      'interface',
      2,
      fullPath,
      intf.lineStart,
      intf.lineEnd,
      {
        packageName: intf.packageName,
        extends: intf.extends,
        annotations: intf.annotations,
        methodCount: intf.methods.length,
        fieldCount: intf.fields.length
      }
    ));

    edges.push(this.createEdge(
      `${fileId}_contains_${interfaceId}`,
      fileId,
      interfaceId,
      'contains'
    ));

    for (const method of intf.methods) {
      const methodId = `method_${interfaceId}_${this.sanitizeId(method.name)}_${method.lineStart}`;
      nodes.push(this.createNode(
        methodId,
        method.name,
        'interface_method',
        4,
        fullPath,
        method.lineStart,
        method.lineEnd,
        {
          returnType: method.returnType,
          parameters: method.parameters,
          annotations: method.annotations
        }
      ));

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
    const packageName = this.extractPackage(content) || 'default';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

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
          const classEndLine = this.findClassEnd(lines, i);

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

  private extractInterfaces(content: string, filePath: string): JavaInterface[] {
    const interfaces: JavaInterface[] = [];
    const lines = content.split('\n');
    const packageName = this.extractPackage(content) || 'default';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('interface ') && !line.startsWith('//')) {
        const interfaceMatch = line.match(/\b(public|private|protected|\s)*\s*interface\s+(\w+)/);

        if (interfaceMatch) {
          const interfaceName = interfaceMatch[2];
          const extendsMatch = line.match(/extends\s+([^{]+)/);

          const extendsInterfaces: string[] = extendsMatch
            ? extendsMatch[1].split(',').map(s => s.trim())
            : [];

          const interfaceStartLine = i + 1;
          const interfaceEndLine = this.findClassEnd(lines, i);

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

    for (let i = classStart; i < classEnd; i++) {
      const line = lines[i].trim();

      if (this.isMethodDeclaration(line)) {
        const methodMatch = line.match(/\b(\w+)\s*\(/);
        if (methodMatch) {
          const methodName = methodMatch[1];
          const modifiers = this.extractModifiers(line);
          const returnType = this.extractReturnType(line);
          const parameters = this.extractParameters(line);
          const annotations = this.extractAnnotations(lines, i);
          const throwsMatch = line.match(/throws\s+([^{]+)/);
          const throwsExceptions = throwsMatch
            ? throwsMatch[1].split(',').map(s => s.trim())
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
    }

    return methods;
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
    return line.includes('(') && line.includes(')') &&
           !line.startsWith('//') && !line.includes('if') &&
           !line.includes('while') && !line.includes('for') &&
           (line.includes('public') || line.includes('private') ||
            line.includes('protected') || line.includes('void') ||
            !!line.match(/\w+\s+\w+\s*\(/));
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
    for (const [packageName, files] of packages.entries()) {
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
      'spring-framework-detection'
    ];
  }
}