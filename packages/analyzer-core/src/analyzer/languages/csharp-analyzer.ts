import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  CASDocumentation, CASComment, CASTodo, CASImplementationStatus, FileAnalysisResult
} from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';
import { TreeSitterParser } from '../core/tree-sitter-parser';
import type { CSharpASTNode } from '../core/ast-types';
import * as path from 'path';

interface CSharpClass {
  name: string;
  namespace: string;
  filePath: string;
  modifiers: string[];
  baseClass?: string;
  implementedInterfaces: string[];
  fields: CSharpField[];
  properties: CSharpProperty[];
  methods: CSharpMethod[];
  nestedTypes: string[];
  attributes: string[];
  lineStart: number;
  lineEnd: number;
  isAbstract: boolean;
  isSealed: boolean;
  isStatic: boolean;
}

interface CSharpMethod {
  name: string;
  returnType: string;
  parameters: CSharpParameter[];
  modifiers: string[];
  attributes: string[];
  lineStart: number;
  lineEnd: number;
  isConstructor: boolean;
  isDestructor: boolean;
  isStatic: boolean;
  isVirtual: boolean;
  isOverride: boolean;
  isAbstract: boolean;
  isAsync: boolean;
}

interface CSharpProperty {
  name: string;
  type: string;
  modifiers: string[];
  attributes: string[];
  hasGetter: boolean;
  hasSetter: boolean;
  isStatic: boolean;
  isVirtual: boolean;
  isOverride: boolean;
  lineNumber: number;
}

interface CSharpField {
  name: string;
  type: string;
  modifiers: string[];
  attributes: string[];
  initialValue?: string;
  isStatic: boolean;
  isReadonly: boolean;
  isConst: boolean;
  lineNumber: number;
}

interface CSharpParameter {
  name: string;
  type: string;
  modifiers: string[];
  defaultValue?: string;
  isRef: boolean;
  isOut: boolean;
  isParams: boolean;
}

interface CSharpInterface {
  name: string;
  namespace: string;
  filePath: string;
  baseInterfaces: string[];
  methods: CSharpMethod[];
  properties: CSharpProperty[];
  attributes: string[];
  lineStart: number;
  lineEnd: number;
}

interface CSharpUsing {
  namespace: string;
  alias?: string;
  lineNumber: number;
  isStatic: boolean;
  isGlobal: boolean;
}

interface CSharpEnum {
  name: string;
  namespace: string;
  filePath: string;
  modifiers: string[];
  baseType?: string;
  values: CSharpEnumValue[];
  attributes: string[];
  lineStart: number;
  lineEnd: number;
}

interface CSharpEnumValue {
  name: string;
  value?: string;
  attributes: string[];
  lineNumber: number;
}

interface CSharpStruct {
  name: string;
  namespace: string;
  filePath: string;
  modifiers: string[];
  implementedInterfaces: string[];
  fields: CSharpField[];
  properties: CSharpProperty[];
  methods: CSharpMethod[];
  attributes: string[];
  lineStart: number;
  lineEnd: number;
  isReadonly: boolean;
}

interface CSharpFallbackCallGraphIndex {
  edgeIds: Set<string>;
  exitIds: Set<string>;
  classIds: Set<string>;
  methodsInFileByPath: Map<string, CASNode[]>;
  methodNodesByName: Map<string, CASNode[]>;
  classNodesByName: Map<string, CASNode[]>;
  methodsByClassId: Map<string, CASNode[]>;
  classByMethodId: Map<string, CASNode>;
  methodNodesById: Map<string, CASNode>;
  classNodesById: Map<string, CASNode>;
}

export class CSharpAnalyzer extends BaseAnalyzer {
  private aspNetCoreDetected = false;
  private entityFrameworkDetected = false;
  private dotNetCoreProject = false;
  private dotNetFrameworkProject = false;
  private astRunner: TreeSitterParser;
  private astCache = new Map<string, CSharpASTNode>();
  private fileCache = new Map<string, { content: string; lines: string[]; comments: CASComment[] }>();

  constructor() {
    super(
      'csharp',
      'C# Language Analyzer',
      '1.0.0',
      'language'
    );
    this.astRunner = new TreeSitterParser();
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const ignore = this.getCSharpIgnorePatterns({ projectPath });
      const csharpFiles = await glob(['**/*.cs'], {
        cwd: projectPath,
        ignore,
        nodir: true
      });

      const projectFiles = await glob(['**/*.csproj', '**/*.sln', '**/*.vbproj'], {
        cwd: projectPath,
        ignore,
        nodir: true
      });

      return csharpFiles.length > 0 || projectFiles.length > 0;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await glob(['**/*.cs'], {
      cwd: projectPath,
      ignore: this.getCSharpIgnorePatterns({ projectPath }, true),
      nodir: true
    });
    return files.sort();
  }

  private getCSharpIgnorePatterns(context: AnalysisContext, excludeTests = false): string[] {
    const generated = [
      '**/bin/**',
      '**/obj/**',
      '**/*.Designer.cs',
      '**/*.designer.cs',
      '**/*.g.cs',
      '**/*.g.i.cs',
      '**/Migrations/*Snapshot.cs'
    ];

    const tests = excludeTests
      ? ['**/Tests/**', '**/*Test.cs', '**/*Tests.cs']
      : [];

    return [...this.getIgnorePatterns(context), ...generated, ...tests];
  }

  private async getCachedFile(fullPath: string): Promise<{ content: string; lines: string[]; comments: CASComment[] }> {
    const cached = this.fileCache.get(fullPath);
    if (cached) return cached;

    const content = await fs.readFile(fullPath, 'utf-8');
    const lines = content.split('\n');
    const comments = this.extractCommentsFromFile(content, fullPath);
    const fileData = { content, lines, comments };
    this.fileCache.set(fullPath, fileData);
    return fileData;
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const namespaces = new Map<string, string[]>();
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    await this.detectProjectType(context.projectPath);
    await this.analyzeCSharpFile(
      context.filePath,
      context.relativePath,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      namespaces,
      context
    );
    this.detectAspNetPatterns(nodes, edges, entryPoints);
    this.detectProgramEntryPoint(context.relativePath, context.filePath, content, nodes, edges, entryPoints);
    this.detectHostedServices(context.relativePath, context.filePath, content, nodes, edges, entryPoints);
    this.detectDotNetScheduledJobs(context.relativePath, context.filePath, content, nodes, edges, entryPoints);
    this.detectAzureFunctions(context.relativePath, context.filePath, content, nodes, entryPoints);
    this.buildInheritanceRelationships(nodes, edges);
    this.buildInterfaceImplementationEdges(nodes, edges);
    this.linkEnumUsages(nodes, edges);
    await this.analyzeCallGraphFallback(
      context.filePath,
      context.relativePath,
      nodes,
      edges,
      exitPoints,
      nodes.filter(node => node.type === 'method' || node.type === 'function'),
      nodes.filter(node => node.type === 'class' || node.type === 'worker'),
      context.projectPath
    );

    const usings = this.extractUsings(content).map(using => using.namespace);
    const exports = nodes
      .filter(node => ['class', 'interface', 'enum', 'struct', 'method', 'property'].includes(node.type))
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
      usings,
      exports
    );
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const libraries: any[] = [];

    try {
      this.fileCache.clear();
      await this.detectProjectType(context.projectPath);
      await this.extractDependencies(context.projectPath, libraries);

      const csharpFiles = await glob(['**/*.cs'], {
        cwd: context.projectPath,
        ignore: this.getCSharpIgnorePatterns(context, true),
        nodir: true
      });
      csharpFiles.sort();

      const namespaces = new Map<string, string[]>();

      for (const file of csharpFiles) {
        const fullPath = `${context.projectPath}/${file}`;
        await this.analyzeCSharpFile(fullPath, file, nodes, edges, entryPoints, exitPoints, namespaces, context);
      }

      this.buildNamespaceHierarchy(namespaces, nodes, edges);
      this.detectAspNetPatterns(nodes, edges, entryPoints);
      await this.detectDotNetRuntimePatterns(context.projectPath, nodes, edges, entryPoints);
      this.buildInheritanceRelationships(nodes, edges);
      await this.buildProjectReferenceEdges(context.projectPath, nodes, edges);
      this.buildInterfaceImplementationEdges(nodes, edges);
      this.linkEnumUsages(nodes, edges);

      await this.analyzeCallGraph(context.projectPath, nodes, edges, exitPoints);

      const casLibraries = libraries.map((lib: any) => ({
        id: `lib_${this.sanitizeId(lib.name)}`,
        name: lib.name,
        version: lib.version,
        type: lib.type === 'nuget_package' ? 'production' as const : 'production' as const,
        category: lib.type === 'project_reference' ? 'local' : 'nuget',
        package_manager: 'nuget',
        metadata: lib.metadata
      }));

      const contribution = this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          language: 'csharp',
          aspNetCore: this.aspNetCoreDetected,
          entityFramework: this.entityFrameworkDetected,
          dotNetVersion: this.dotNetCoreProject ? 'core' : this.dotNetFrameworkProject ? 'framework' : 'unknown',
          filesAnalyzed: csharpFiles.length,
          namespacesFound: namespaces.size
        }
      });
      contribution.libraries = casLibraries;
      this.fileCache.clear();
      return contribution;

    } catch (error) {
      this.fileCache.clear();
      throw new AnalyzerError(
        `C# analysis failed: ${(error as Error).message}`,
        'CSHARP_ANALYSIS_ERROR'
      );
    }
  }

  private async detectProjectType(projectPath: string): Promise<void> {
    const csprojFiles = await glob(['**/*.csproj'], {
      cwd: projectPath,
      ignore: this.getCSharpIgnorePatterns({ projectPath }),
      nodir: true
    });

    for (const csprojFile of csprojFiles) {
      const csprojPath = `${projectPath}/${csprojFile}`;
      try {
        const csprojContent = await fs.readFile(csprojPath, 'utf-8');

        this.dotNetCoreProject = this.dotNetCoreProject ||
                                csprojContent.includes('<TargetFramework>net') ||
                                csprojContent.includes('<TargetFrameworks>net');

        this.dotNetFrameworkProject = this.dotNetFrameworkProject ||
                                     csprojContent.includes('<TargetFrameworkVersion>') ||
                                     csprojContent.includes('Microsoft.NETFramework');

        this.aspNetCoreDetected = this.aspNetCoreDetected ||
                                 csprojContent.includes('Microsoft.AspNetCore') ||
                                 csprojContent.includes('AspNetCore.Mvc');

        this.entityFrameworkDetected = this.entityFrameworkDetected ||
                                      csprojContent.includes('Microsoft.EntityFrameworkCore') ||
                                      csprojContent.includes('EntityFramework');
      } catch (error) {
        console.warn(`Failed to read project file ${csprojFile}:`, error);
      }
    }
  }

  private async extractDependencies(projectPath: string, libraries: any[]): Promise<void> {
    const csprojFiles = await glob(['**/*.csproj'], {
      cwd: projectPath,
      ignore: this.getCSharpIgnorePatterns({ projectPath }),
      nodir: true
    });

    for (const csprojFile of csprojFiles) {
      await this.extractCsprojDependencies(`${projectPath}/${csprojFile}`, libraries);
    }

    const packagesConfigFiles = await glob(['**/packages.config'], {
      cwd: projectPath,
      ignore: this.getCSharpIgnorePatterns({ projectPath }),
      nodir: true
    });

    for (const packagesFile of packagesConfigFiles) {
      await this.extractPackagesConfigDependencies(`${projectPath}/${packagesFile}`, libraries);
    }
  }

  private async extractCsprojDependencies(csprojPath: string, libraries: any[]): Promise<void> {
    try {
      const csprojContent = await fs.readFile(csprojPath, 'utf-8');
      const packageRefMatches = csprojContent.matchAll(/<PackageReference\s+Include="([^"]+)"\s+Version="([^"]+)"/g);

      for (const match of packageRefMatches) {
        const packageName = match[1];
        const version = match[2];

        libraries.push({
          name: packageName,
          version: version,
          type: 'nuget_package',
          source: 'csproj',
          metadata: {
            packageManager: 'nuget',
            isProduction: true
          }
        });
      }

      const projectRefMatches = csprojContent.matchAll(/<ProjectReference\s+Include="([^"]+)"/g);
      for (const match of projectRefMatches) {
        libraries.push({
          name: match[1],
          version: 'local',
          type: 'project_reference',
          source: 'csproj',
          metadata: {
            isLocalProject: true
          }
        });
      }
    } catch (error) {
      console.warn('Failed to parse csproj file:', error);
    }
  }

  private async extractPackagesConfigDependencies(packagesConfigPath: string, libraries: any[]): Promise<void> {
    try {
      const packagesContent = await fs.readFile(packagesConfigPath, 'utf-8');
      const packageMatches = packagesContent.matchAll(/<package\s+id="([^"]+)"\s+version="([^"]+)"/g);

      for (const match of packageMatches) {
        libraries.push({
          name: match[1],
          version: match[2],
          type: 'nuget_package',
          source: 'packages.config',
          metadata: {
            packageManager: 'nuget',
            isProduction: true
          }
        });
      }
    } catch (error) {
      console.warn('Failed to parse packages.config:', error);
    }
  }

  private async analyzeCSharpFile(
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
      const fileData = await this.getCachedFile(fullPath);
      const { content, lines } = fileData;

      const namespace = this.extractNamespace(content);
      const usings = this.extractUsings(content);
      const classes = this.extractClasses(content, relativePath);
      const interfaces = this.extractInterfaces(content, relativePath);
      const enums = this.extractEnums(content, relativePath);
      const structs = this.extractStructs(content, relativePath);

      if (namespace) {
        if (!namespaces.has(namespace)) {
          namespaces.set(namespace, []);
        }
        namespaces.get(namespace)!.push(relativePath);
      }

      const fileId = `file_${this.sanitizeId(relativePath)}`;
      const fileComments = fileData.comments;
      const fileTodos = this.extractTodosFromComments(fileComments, fullPath);

      const fileNode = this.createNodeBuilder(fileId, relativePath.split('/').pop() || 'unknown.cs', 'file')
        .withLevel(1, this.getLevelName(1))
        .withSource({ file: fullPath, line: 1, end_line: lines.length })
        .withMetadata({
          language: 'csharp',
          attributes: {
            namespace: namespace || 'global',
            usings: usings.map(u => u.namespace),
            classCount: classes.length,
            interfaceCount: interfaces.length,
            enumCount: enums.length,
            structCount: structs.length
          }
        })
        .withComments(fileComments.length > 0 ? fileComments : undefined)
        .withTodos(fileTodos.length > 0 ? fileTodos : undefined)
        .withAnalyzers([this.analyzerId], this.analyzerId)
        .build();
      nodes.push(fileNode);

      for (const using of usings) {
        const usingId = `using_${fileId}_${this.sanitizeId(using.namespace)}`;
        nodes.push(this.createNode(
          usingId,
          using.alias || using.namespace,
          'using',
          2,
          fullPath,
          using.lineNumber,
          using.lineNumber,
          {
            namespace: using.namespace,
            alias: using.alias,
            isStatic: using.isStatic,
            isGlobal: using.isGlobal
          }
        ));

        edges.push(this.createEdge(
          `${fileId}_uses_${usingId}`,
          fileId,
          usingId,
          'uses'
        ));

        if (!this.isSystemNamespace(using.namespace) && !using.namespace.startsWith(namespace || '')) {
          exitPoints.push({
            id: `exit_${usingId}`,
            name: `External namespace: ${using.namespace}`,
            type: 'external_namespace',
            source_node: usingId,
            metadata: { namespace: using.namespace }
          });
        }
      }

      for (const cls of classes) {
        await this.processCSharpClass(cls, fileId, fullPath, content, lines, fileComments, nodes, edges, entryPoints);
      }

      for (const intf of interfaces) {
        await this.processCSharpInterface(intf, fileId, fullPath, lines, nodes, edges, entryPoints);
      }

      for (const enm of enums) {
        await this.processCSharpEnum(enm, fileId, fullPath, nodes, edges, entryPoints);
      }

      for (const struct of structs) {
        await this.processCSharpStruct(struct, fileId, fullPath, nodes, edges, entryPoints);
      }

    } catch (error) {
      console.warn(`Failed to analyze C# file ${relativePath}:`, error);
    }
  }

  private async processCSharpClass(
    cls: CSharpClass,
    fileId: string,
    fullPath: string,
    content: string,
    lines: string[],
    fileComments: CASComment[],
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const classId = `class_${this.sanitizeId(cls.namespace)}_${this.sanitizeId(cls.name)}`;

    const documentation = this.extractDocumentationFromXmlComment(lines, cls.lineStart - 1);
    const classComments = fileComments.filter(c =>
      c.location.line >= cls.lineStart &&
      (c.location.end_line ? c.location.end_line <= cls.lineEnd : c.location.line <= cls.lineEnd)
    );
    const todos = this.extractTodosFromComments(classComments, `class ${cls.name}`);

    const classNode = this.createNodeBuilder(
      classId,
      cls.name,
      'class'
    )
      .withLevel(2, 'Class/Interface')
      .withCategory('structures', ['classes'])
      .withSource({ file: fullPath, line: cls.lineStart, end_line: cls.lineEnd })
      .withMetadata({
        attributes: {
          namespace: cls.namespace,
          modifiers: cls.modifiers,
          baseClass: cls.baseClass,
          implementedInterfaces: cls.implementedInterfaces,
          csharpAttributes: cls.attributes,
          fieldCount: cls.fields.length,
          propertyCount: cls.properties.length,
          methodCount: cls.methods.length,
          isPublic: cls.modifiers.includes('public'),
          isAbstract: cls.isAbstract,
          isSealed: cls.isSealed,
          isStatic: cls.isStatic
        }
      })
      .withDocumentation(documentation)
      .withComments(classComments.length > 0 ? classComments : undefined)
      .withTodos(todos.length > 0 ? todos : undefined)
      .withAnalyzers([this.analyzerId], this.analyzerId)
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
        fullPath,
        field.lineNumber,
        field.lineNumber,
        {
          type: field.type,
          modifiers: field.modifiers,
          attributes: field.attributes,
          isStatic: field.isStatic,
          isReadonly: field.isReadonly,
          isConst: field.isConst,
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

    for (const property of cls.properties) {
      const propertyId = `property_${classId}_${this.sanitizeId(property.name)}`;
      nodes.push(this.createNode(
        propertyId,
        property.name,
        'property',
        4,
        fullPath,
        property.lineNumber,
        property.lineNumber,
        {
          type: property.type,
          modifiers: property.modifiers,
          attributes: property.attributes,
          hasGetter: property.hasGetter,
          hasSetter: property.hasSetter,
          isStatic: property.isStatic,
          isVirtual: property.isVirtual,
          isOverride: property.isOverride
        }
      ));

      edges.push(this.createEdge(
        `${classId}_has_property_${propertyId}`,
        classId,
        propertyId,
        'has_property'
      ));
    }

    for (const method of cls.methods) {
      const methodId = `method_${classId}_${this.sanitizeId(method.name)}_${method.lineStart}`;

      const methodDocumentation = this.extractDocumentationFromXmlComment(lines, method.lineStart - 1);
      const methodComments = fileComments.filter(c =>
        c.location.line >= method.lineStart &&
        (c.location.end_line ? c.location.end_line <= method.lineEnd : c.location.line <= method.lineEnd)
      );
      const methodTodos = this.extractTodosFromComments(methodComments, `method ${cls.name}.${method.name}`);

      const methodBodyLines = lines.slice(method.lineStart - 1, method.lineEnd);
      const implementationStatus = this.detectImplementationStatus(method, methodBodyLines);

      const methodNode = this.createNodeBuilder(
        methodId,
        method.name,
        'method'
      )
        .withLevel(4, 'Method/Function')
        .withCategory('methods', ['class-methods'])
        .withSource({ file: fullPath, line: method.lineStart, end_line: method.lineEnd })
        .withMetadata({
          attributes: {
            returnType: method.returnType,
            parameters: method.parameters,
            modifiers: method.modifiers,
            csharpAttributes: method.attributes,
            isConstructor: method.isConstructor,
            isDestructor: method.isDestructor,
            isStatic: method.isStatic,
            isVirtual: method.isVirtual,
            isOverride: method.isOverride,
            isAbstract: method.isAbstract,
            isAsync: method.isAsync,
            isPublic: method.modifiers.includes('public')
          }
        })
        .withParent(classId)
        .withDocumentation(methodDocumentation)
        .withComments(methodComments.length > 0 ? methodComments : undefined)
        .withTodos(methodTodos.length > 0 ? methodTodos : undefined)
        .withImplementationStatus(implementationStatus)
        .withAnalyzers([this.analyzerId], this.analyzerId)
        .build();

      nodes.push(methodNode);

      edges.push(this.createEdge(
        `${classId}_has_method_${methodId}`,
        classId,
        methodId,
        'has_method'
      ));

    }
  }

  private async processCSharpInterface(
    intf: CSharpInterface,
    fileId: string,
    fullPath: string,
    lines: string[],
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const interfaceId = `interface_${this.sanitizeId(intf.namespace)}_${this.sanitizeId(intf.name)}`;
    const documentation = this.extractDocumentationFromXmlComment(lines, intf.lineStart - 1);

    const interfaceNode = this.createNodeBuilder(interfaceId, intf.name, 'interface')
      .withLevel(2, this.getLevelName(2))
      .withCategory('structures', ['interfaces'])
      .withSource({ file: fullPath, line: intf.lineStart, end_line: intf.lineEnd })
      .withMetadata({
        language: 'csharp',
        attributes: {
          namespace: intf.namespace,
          baseInterfaces: intf.baseInterfaces,
          csharpAttributes: intf.attributes,
          methodCount: intf.methods.length,
          propertyCount: intf.properties.length
        }
      })
      .withDocumentation(documentation)
      .withAnalyzers([this.analyzerId], this.analyzerId)
      .build();
    nodes.push(interfaceNode);

    edges.push(this.createEdge(
      `${fileId}_contains_${interfaceId}`,
      fileId,
      interfaceId,
      'contains'
    ));

    for (const method of intf.methods) {
      const methodId = `method_${interfaceId}_${this.sanitizeId(method.name)}_${method.lineStart}`;
      const methodNode = this.createNodeBuilder(methodId, method.name, 'interface_method')
        .withLevel(4, this.getLevelName(4))
        .withCategory('methods', ['interface-methods'])
        .withSource({ file: fullPath, line: method.lineStart, end_line: method.lineEnd })
        .withParent(interfaceId)
        .withMetadata({
          language: 'csharp',
          attributes: {
            returnType: method.returnType,
            parameters: method.parameters,
            csharpAttributes: method.attributes
          }
        })
        .withAnalyzers([this.analyzerId], this.analyzerId)
        .build();
      nodes.push(methodNode);

      edges.push(this.createEdge(
        `${interfaceId}_declares_${methodId}`,
        interfaceId,
        methodId,
        'declares'
      ));
    }

    for (const property of intf.properties) {
      const propertyId = `property_${interfaceId}_${this.sanitizeId(property.name)}`;
      const propertyNode = this.createNodeBuilder(propertyId, property.name, 'interface_property')
        .withLevel(4, this.getLevelName(4))
        .withCategory('properties', ['interface-properties'])
        .withSource({ file: fullPath, line: property.lineNumber, end_line: property.lineNumber })
        .withParent(interfaceId)
        .withMetadata({
          language: 'csharp',
          attributes: {
            type: property.type,
            hasGetter: property.hasGetter,
            hasSetter: property.hasSetter
          }
        })
        .withAnalyzers([this.analyzerId], this.analyzerId)
        .build();
      nodes.push(propertyNode);

      edges.push(this.createEdge(
        `${interfaceId}_declares_${propertyId}`,
        interfaceId,
        propertyId,
        'declares'
      ));
    }

  }

  private async processCSharpEnum(
    enm: CSharpEnum,
    fileId: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const enumId = `enum_${this.sanitizeId(enm.namespace)}_${this.sanitizeId(enm.name)}`;

    const enumNode = this.createNodeBuilder(enumId, enm.name, 'enum')
      .withLevel(2, this.getLevelName(2))
      .withCategory('structures', ['enums'])
      .withSource({ file: fullPath, line: enm.lineStart, end_line: enm.lineEnd })
      .withMetadata({
        language: 'csharp',
        attributes: {
          namespace: enm.namespace,
          modifiers: enm.modifiers,
          baseType: enm.baseType,
          csharpAttributes: enm.attributes,
          valueCount: enm.values.length
        }
      })
      .withAnalyzers([this.analyzerId], this.analyzerId)
      .build();
    nodes.push(enumNode);

    edges.push(this.createEdge(
      `${fileId}_contains_${enumId}`,
      fileId,
      enumId,
      'contains'
    ));

    for (const value of enm.values) {
      const valueId = `enumvalue_${enumId}_${this.sanitizeId(value.name)}`;
      nodes.push(this.createNode(
        valueId,
        value.name,
        'enum_value',
        4,
        fullPath,
        value.lineNumber,
        value.lineNumber,
        {
          value: value.value,
          attributes: value.attributes
        }
      ));

      edges.push(this.createEdge(
        `${enumId}_has_value_${valueId}`,
        enumId,
        valueId,
        'has_value'
      ));
    }

    if (enm.modifiers.includes('public')) {
      entryPoints.push({
        id: `entry_${enumId}`,
        name: `Public enum: ${enm.name}`,
        type: 'public_enum',
        source_node: enumId,
        metadata: {
          namespace: enm.namespace,
          enumName: enm.name,
          attributes: enm.attributes
        }
      });
    }
  }

  private async processCSharpStruct(
    struct: CSharpStruct,
    fileId: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const structId = `struct_${this.sanitizeId(struct.namespace)}_${this.sanitizeId(struct.name)}`;

    const structNode = this.createNodeBuilder(structId, struct.name, 'struct')
      .withLevel(2, this.getLevelName(2))
      .withCategory('structures', ['structs'])
      .withSource({ file: fullPath, line: struct.lineStart, end_line: struct.lineEnd })
      .withMetadata({
        language: 'csharp',
        attributes: {
          namespace: struct.namespace,
          modifiers: struct.modifiers,
          implementedInterfaces: struct.implementedInterfaces,
          csharpAttributes: struct.attributes,
          fieldCount: struct.fields.length,
          propertyCount: struct.properties.length,
          methodCount: struct.methods.length,
          isReadonly: struct.isReadonly
        }
      })
      .withAnalyzers([this.analyzerId], this.analyzerId)
      .build();
    nodes.push(structNode);

    edges.push(this.createEdge(
      `${fileId}_contains_${structId}`,
      fileId,
      structId,
      'contains'
    ));

    for (const field of struct.fields) {
      const fieldId = `field_${structId}_${this.sanitizeId(field.name)}`;
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
          attributes: field.attributes,
          isStatic: field.isStatic,
          isReadonly: field.isReadonly,
          isConst: field.isConst
        }
      ));

      edges.push(this.createEdge(
        `${structId}_has_field_${fieldId}`,
        structId,
        fieldId,
        'has_field'
      ));
    }

    if (struct.modifiers.includes('public')) {
      entryPoints.push({
        id: `entry_${structId}`,
        name: `Public struct: ${struct.name}`,
        type: 'public_struct',
        source_node: structId,
        metadata: {
          namespace: struct.namespace,
          structName: struct.name,
          attributes: struct.attributes
        }
      });
    }
  }

  private extractNamespace(content: string): string | null {
    const namespaceMatch = content.match(/namespace\s+([a-zA-Z0-9_.]+)/);
    return namespaceMatch ? namespaceMatch[1] : null;
  }

  private extractUsings(content: string): CSharpUsing[] {
    const usings: CSharpUsing[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      const globalUsingMatch = line.match(/^global\s+using\s+(static\s+)?([a-zA-Z0-9_.]+)(?:\s*=\s*([a-zA-Z0-9_.]+))?\s*;/);
      if (globalUsingMatch) {
        usings.push({
          namespace: globalUsingMatch[3] || globalUsingMatch[2],
          alias: globalUsingMatch[3] ? globalUsingMatch[2] : undefined,
          lineNumber: i + 1,
          isStatic: !!globalUsingMatch[1],
          isGlobal: true
        });
        continue;
      }

      const usingMatch = line.match(/^using\s+(static\s+)?([a-zA-Z0-9_.]+)(?:\s*=\s*([a-zA-Z0-9_.]+))?\s*;/);
      if (usingMatch) {
        usings.push({
          namespace: usingMatch[3] || usingMatch[2],
          alias: usingMatch[3] ? usingMatch[2] : undefined,
          lineNumber: i + 1,
          isStatic: !!usingMatch[1],
          isGlobal: false
        });
      }
    }

    return usings;
  }

  private extractClasses(content: string, filePath: string): CSharpClass[] {
    const classes: CSharpClass[] = [];
    const lines = content.split('\n');
    const namespace = this.extractNamespace(content) || 'global';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('class ') && !line.startsWith('//') && !line.includes('interface')) {
        const classMatch = line.match(/\b(public|private|protected|internal|abstract|sealed|static|\s)*\s*class\s+(\w+)/);

        if (classMatch) {
          const modifiers = this.extractModifiers(line);
          const className = classMatch[2];
          const baseClassMatch = line.match(/:\s*([^,{]+)/);
          const implementsMatch = line.match(/:\s*[^,{]*,\s*(.+)/);

          const baseClass = baseClassMatch ? baseClassMatch[1].trim() : undefined;
          const implementedInterfaces: string[] = implementsMatch
            ? implementsMatch[1].split(',').map(s => s.trim())
            : [];

          const classStartLine = i + 1;
          const classEndLine = this.findBlockEnd(lines, i);

          const fields = this.extractFields(lines, i, classEndLine);
          const properties = this.extractProperties(lines, i, classEndLine);
          const methods = this.extractMethods(lines, i, classEndLine, className);
          const attributes = this.extractAttributes(lines, i);

          classes.push({
            name: className,
            namespace,
            filePath,
            modifiers,
            baseClass,
            implementedInterfaces,
            fields,
            properties,
            methods,
            nestedTypes: [],
            attributes,
            lineStart: classStartLine,
            lineEnd: classEndLine,
            isAbstract: modifiers.includes('abstract'),
            isSealed: modifiers.includes('sealed'),
            isStatic: modifiers.includes('static')
          });
        }
      }
    }

    return classes;
  }

  private extractInterfaces(content: string, filePath: string): CSharpInterface[] {
    const interfaces: CSharpInterface[] = [];
    const lines = content.split('\n');
    const namespace = this.extractNamespace(content) || 'global';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('interface ') && !line.startsWith('//')) {
        const interfaceMatch = line.match(/\b(public|private|protected|internal|\s)*\s*interface\s+(\w+)/);

        if (interfaceMatch) {
          const interfaceName = interfaceMatch[2];
          const baseInterfacesMatch = line.match(/:\s*(.+)/);

          const baseInterfaces: string[] = baseInterfacesMatch
            ? baseInterfacesMatch[1].split(',').map(s => s.trim())
            : [];

          const interfaceStartLine = i + 1;
          const interfaceEndLine = this.findBlockEnd(lines, i);

          const methods = this.extractMethods(lines, i, interfaceEndLine, interfaceName);
          const properties = this.extractProperties(lines, i, interfaceEndLine);
          const attributes = this.extractAttributes(lines, i);

          interfaces.push({
            name: interfaceName,
            namespace,
            filePath,
            baseInterfaces,
            methods,
            properties,
            attributes,
            lineStart: interfaceStartLine,
            lineEnd: interfaceEndLine
          });
        }
      }
    }

    return interfaces;
  }

  private extractEnums(content: string, filePath: string): CSharpEnum[] {
    const enums: CSharpEnum[] = [];
    const lines = content.split('\n');
    const namespace = this.extractNamespace(content) || 'global';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('enum ') && !line.startsWith('//')) {
        const enumMatch = line.match(/\b(public|private|protected|internal|\s)*\s*enum\s+(\w+)(?:\s*:\s*(\w+))?/);

        if (enumMatch) {
          const modifiers = this.extractModifiers(line);
          const enumName = enumMatch[2];
          const baseType = enumMatch[3];

          const enumStartLine = i + 1;
          const enumEndLine = this.findBlockEnd(lines, i);

          const values = this.extractEnumValues(lines, i, enumEndLine);
          const attributes = this.extractAttributes(lines, i);

          enums.push({
            name: enumName,
            namespace,
            filePath,
            modifiers,
            baseType,
            values,
            attributes,
            lineStart: enumStartLine,
            lineEnd: enumEndLine
          });
        }
      }
    }

    return enums;
  }

  private extractStructs(content: string, filePath: string): CSharpStruct[] {
    const structs: CSharpStruct[] = [];
    const lines = content.split('\n');
    const namespace = this.extractNamespace(content) || 'global';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('struct ') && !line.startsWith('//')) {
        const structMatch = line.match(/\b(public|private|protected|internal|readonly|\s)*\s*struct\s+(\w+)/);

        if (structMatch) {
          const modifiers = this.extractModifiers(line);
          const structName = structMatch[2];
          const implementsMatch = line.match(/:\s*(.+)/);

          const implementedInterfaces: string[] = implementsMatch
            ? implementsMatch[1].split(',').map(s => s.trim())
            : [];

          const structStartLine = i + 1;
          const structEndLine = this.findBlockEnd(lines, i);

          const fields = this.extractFields(lines, i, structEndLine);
          const properties = this.extractProperties(lines, i, structEndLine);
          const methods = this.extractMethods(lines, i, structEndLine, structName);
          const attributes = this.extractAttributes(lines, i);

          structs.push({
            name: structName,
            namespace,
            filePath,
            modifiers,
            implementedInterfaces,
            fields,
            properties,
            methods,
            attributes,
            lineStart: structStartLine,
            lineEnd: structEndLine,
            isReadonly: modifiers.includes('readonly')
          });
        }
      }
    }

    return structs;
  }

  private extractMethods(lines: string[], classStart: number, classEnd: number, ownerName?: string): CSharpMethod[] {
    const methods: CSharpMethod[] = [];

    for (let i = classStart; i < classEnd; i++) {
      const line = lines[i].trim();

      if (this.isMethodDeclaration(line)) {
        const methodName = this.extractMethodName(line);
        if (methodName) {
          const modifiers = this.extractModifiers(line);
          const returnType = this.extractReturnType(line);
          const parameters = this.extractParameters(line);
          const attributes = this.extractAttributes(lines, i);

          const methodEndLine = this.findMethodEnd(lines, i);

          const isConstructor = methodName === ownerName;
          const isDestructor = methodName.startsWith('~');
          const isAsync = line.includes('async ');

          methods.push({
            name: methodName,
            returnType,
            parameters,
            modifiers,
            attributes,
            lineStart: i + 1,
            lineEnd: methodEndLine,
            isConstructor,
            isDestructor,
            isStatic: modifiers.includes('static'),
            isVirtual: modifiers.includes('virtual'),
            isOverride: modifiers.includes('override'),
            isAbstract: modifiers.includes('abstract'),
            isAsync
          });
        }
      }
    }

    return methods;
  }

  private extractProperties(lines: string[], classStart: number, classEnd: number): CSharpProperty[] {
    const properties: CSharpProperty[] = [];

    for (let i = classStart; i < classEnd; i++) {
      const line = lines[i].trim();

      if (this.isPropertyDeclaration(line)) {
        const propertyMatch = line.match(/(\w+)\s+(\w+)\s*\{/);
        if (propertyMatch) {
          const type = propertyMatch[1];
          const propertyName = propertyMatch[2];
          const modifiers = this.extractModifiers(line);
          const attributes = this.extractAttributes(lines, i);

          const hasGetter = line.includes('get') || line.includes('{ get');
          const hasSetter = line.includes('set') || line.includes('{ set');

          properties.push({
            name: propertyName,
            type,
            modifiers,
            attributes,
            hasGetter,
            hasSetter,
            isStatic: modifiers.includes('static'),
            isVirtual: modifiers.includes('virtual'),
            isOverride: modifiers.includes('override'),
            lineNumber: i + 1
          });
        }
      }
    }

    return properties;
  }

  private extractFields(lines: string[], classStart: number, classEnd: number): CSharpField[] {
    const fields: CSharpField[] = [];

    for (let i = classStart; i < classEnd; i++) {
      const line = lines[i].trim();

      if (this.isFieldDeclaration(line)) {
        const fieldMatch = line.match(/(\w+)\s+(\w+)(?:\s*=\s*([^;]+))?/);
        if (fieldMatch) {
          const type = fieldMatch[1];
          const fieldName = fieldMatch[2];
          const initialValue = fieldMatch[3]?.trim();
          const modifiers = this.extractModifiers(line);
          const attributes = this.extractAttributes(lines, i);

          fields.push({
            name: fieldName,
            type,
            modifiers,
            attributes,
            initialValue,
            isStatic: modifiers.includes('static'),
            isReadonly: modifiers.includes('readonly'),
            isConst: modifiers.includes('const'),
            lineNumber: i + 1
          });
        }
      }
    }

    return fields;
  }

  private extractEnumValues(lines: string[], enumStart: number, enumEnd: number): CSharpEnumValue[] {
    const values: CSharpEnumValue[] = [];

    for (let i = enumStart + 1; i < enumEnd; i++) {
      const line = lines[i].trim();

      if (line && !line.startsWith('//') && !line.startsWith('{') && !line.startsWith('}')) {
        const valueMatch = line.match(/(\w+)(?:\s*=\s*([^,]+))?/);
        if (valueMatch) {
          const valueName = valueMatch[1];
          const value = valueMatch[2]?.trim();
          const attributes = this.extractAttributes(lines, i);

          values.push({
            name: valueName,
            value,
            attributes,
            lineNumber: i + 1
          });
        }
      }
    }

    return values;
  }


  private isPropertyDeclaration(line: string): boolean {
    return line.includes('{') && !line.includes('(') &&
           !line.includes('=') && !line.startsWith('//') &&
           (line.includes('public') || line.includes('private') ||
            line.includes('protected') || line.includes('internal') ||
            !!line.match(/\w+\s+\w+\s*\{/));
  }

  private isFieldDeclaration(line: string): boolean {
    return (line.includes('=') || line.endsWith(';')) &&
           !line.includes('(') && !line.includes('return') &&
           !line.includes('{') && !line.startsWith('//') &&
           !line.includes('if') && !line.includes('for') &&
           (line.includes('private') || line.includes('public') ||
            line.includes('protected') || line.includes('internal') ||
            !!line.match(/\w+\s+\w+\s*[=;]/));
  }

  private extractModifiers(line: string): string[] {
    const modifiers: string[] = [];
    const modifierKeywords = [
      'public', 'private', 'protected', 'internal',
      'static', 'readonly', 'const', 'virtual', 'override',
      'abstract', 'sealed', 'async', 'extern', 'unsafe'
    ];

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

    return returnTypeIndex > 0 ? parts[returnTypeIndex] : 'void';
  }

  private extractMethodName(line: string): string | undefined {
    const beforeParen = line.slice(0, line.indexOf('(')).trim();
    if (!beforeParen) return undefined;
    const token = beforeParen.split(/\s+/).pop();
    return token?.replace(/^.*\./, '').replace(/<.*>$/, '');
  }

  private extractParameters(line: string): CSharpParameter[] {
    const parameters: CSharpParameter[] = [];
    const paramMatch = line.match(/\((.*?)\)/);

    if (paramMatch && paramMatch[1].trim()) {
      const paramString = paramMatch[1];
      const params = this.splitParameters(paramString);

      for (const param of params) {
        const trimmed = param.trim();
        const paramMatch = trimmed.match(/^(ref\s+|out\s+|params\s+)?([\w.<>,?\[\]]+)\s+(\w+)(?:\s*=\s*(.+))?$/);

        if (paramMatch) {
          const modifier = paramMatch[1]?.trim();
          const type = paramMatch[2];
          const name = paramMatch[3];
          const defaultValue = paramMatch[4]?.trim();

          parameters.push({
            name,
            type,
            modifiers: modifier ? [modifier] : [],
            defaultValue,
            isRef: modifier === 'ref',
            isOut: modifier === 'out',
            isParams: modifier === 'params'
          });
        }
      }
    }

    return parameters;
  }

  private splitParameters(paramString: string): string[] {
    const params: string[] = [];
    let current = '';
    let depth = 0;

    for (const char of paramString) {
      if (char === '<') depth++;
      else if (char === '>') depth--;
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

  private extractAttributes(lines: string[], lineIndex: number): string[] {
    const attributes: string[] = [];

    for (let i = lineIndex - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('[') && line.endsWith(']')) {
        const attributeMatch = line.match(/\[([^\]]+)\]/);
        if (attributeMatch) {
          attributes.unshift(attributeMatch[1]);
        }
      } else if (line && !line.startsWith('//')) {
        break;
      }
    }

    return attributes;
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

      nodes.push(this.createNode(
        namespaceId,
        namespaceName,
        'namespace',
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
          `${namespaceId}_contains_${fileId}`,
          namespaceId,
          fileId,
          'contains'
        ));
      }
    }
  }

  private detectAspNetPatterns(nodes: CASNode[], _edges: CASEdge[], entryPoints: any[]): void {
    if (!this.aspNetCoreDetected) return;

    const aspNetAttributes = ['Controller', 'ApiController', 'Route', 'HttpGet', 'HttpPost', 'HttpPut', 'HttpDelete'];

    for (const node of nodes) {
      if ((node.type === 'class' || node.type === 'method') && node.metadata?.attributes) {
        const attributes = this.getCSharpAttributeList(node);
        const aspNetAttribute = attributes.find(a => aspNetAttributes.some(attr => a.includes(attr)));

        if (aspNetAttribute) {
          this.setMetadataAttribute(node, 'aspNetComponent', aspNetAttribute);

          if (!node || typeof node !== 'object') return;

          if (node.type === 'class' && attributes.some(a => a.includes('Controller'))) {
            entryPoints.push({
              id: `entry_aspnet_${node.id}`,
              name: `ASP.NET Controller: ${node.name}`,
              type: 'http',
              source_node: node.id,
              metadata: {
                attribute: aspNetAttribute,
                className: node.name
              }
            });
          }

          if (!node || typeof node !== 'object') return;

          if (node.type === 'method' && attributes.some(a => a.includes('Http'))) {
            const httpMethod = aspNetAttribute.replace('Http', '').toUpperCase() || 'GET';
            entryPoints.push({
              id: `entry_aspnet_${node.id}`,
              name: `ASP.NET Endpoint: ${node.name}`,
              type: 'http',
              source_node: node.id,
              trigger: {
                method: httpMethod,
                path: `/${node.name}`
              },
              metadata: {
                attribute: aspNetAttribute,
                methodName: node.name
              }
            });
          }
        }
      }
    }
  }

  private async detectDotNetRuntimePatterns(
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): Promise<void> {
    const csharpFiles = await glob(['**/*.cs'], {
      cwd: projectPath,
      ignore: this.getCSharpIgnorePatterns({ projectPath }, true),
      nodir: true
    });
    csharpFiles.sort();

    for (const relativeFile of csharpFiles) {
      const fullPath = path.join(projectPath, relativeFile);
      let content = '';
      try {
        content = (await this.getCachedFile(fullPath)).content;
      } catch {
        continue;
      }

      this.detectProgramEntryPoint(relativeFile, fullPath, content, nodes, edges, entryPoints);
      this.detectHostedServices(relativeFile, fullPath, content, nodes, edges, entryPoints);
      this.detectDotNetScheduledJobs(relativeFile, fullPath, content, nodes, edges, entryPoints);
      this.detectAzureFunctions(relativeFile, fullPath, content, nodes, entryPoints);
    }
  }

  private detectProgramEntryPoint(
    relativeFile: string,
    fullPath: string,
    content: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const hasExplicitMain = /\bstatic\s+(?:async\s+)?(?:Task|void|int)\s+Main\s*\(/.test(content);
    const hasTopLevelHost = /\b(?:WebApplication|Host)\.(?:CreateBuilder|CreateDefaultBuilder|CreateApplicationBuilder)\s*\(/.test(content) ||
      /\b(?:app|host)\.(?:Run|RunAsync)\s*\(/.test(content);
    const looksLikeProgram = path.basename(relativeFile).toLowerCase() === 'program.cs';
    if (!hasExplicitMain && !(looksLikeProgram && hasTopLevelHost)) return;

    const fileNode = this.findFileNode(nodes, fullPath);
    const line = this.lineNumberFor(content, hasExplicitMain ? /\bstatic\s+(?:async\s+)?(?:Task|void|int)\s+Main\s*\(/ : /\b(?:WebApplication|Host)\.(?:CreateBuilder|CreateDefaultBuilder|CreateApplicationBuilder)\s*\(/);
    const nodeId = `dotnet_program_${this.sanitizeId(relativeFile)}_${line}`;
    if (!nodes.some(node => node.id === nodeId)) {
      nodes.push(this.createNodeBuilder(nodeId, 'Program entry point', 'host_entry')
        .withLevel(3, this.getLevelName(3))
        .withSource({ file: fullPath, line })
        .withMetadata({
          language: 'csharp',
          framework: hasTopLevelHost ? 'dotnet-host' : 'dotnet',
          attributes: {
            explicit_main: hasExplicitMain,
            top_level_host: hasTopLevelHost,
            file: relativeFile
          }
        })
        .withAnalyzers([this.analyzerId], this.analyzerId)
        .build());
      if (fileNode) edges.push(this.createEdge(`${fileNode.id}_contains_${nodeId}`, fileNode.id, nodeId, 'contains'));
    }

    this.pushUniqueEntryPoint(entryPoints, {
      id: `entry_dotnet_program_${this.sanitizeId(relativeFile)}_${line}`,
      source_node: nodeId,
      source_analyzer: this.analyzerId,
      type: hasTopLevelHost ? 'lifecycle' : 'cli',
      name: hasTopLevelHost ? '.NET host startup' : '.NET Main entry point',
      description: 'Program.cs starts the .NET process/host for this project.',
      trigger: { event: hasTopLevelHost ? 'host-start' : 'process-start' },
      handler: {
        node_id: nodeId,
        method_name: hasExplicitMain ? 'Main' : 'top-level-statements',
        file: fullPath,
        line
      },
      metadata: {
        language: 'csharp',
        framework: hasTopLevelHost ? 'dotnet-host' : 'dotnet',
        file: relativeFile
      }
    });
  }

  private detectHostedServices(
    relativeFile: string,
    fullPath: string,
    content: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const servicePattern = /class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*<[^>{}]+>)?\s*:\s*([^{]+)\{/g;
    let match: RegExpExecArray | null;
    while ((match = servicePattern.exec(content)) !== null) {
      const serviceName = match[1];
      const inheritance = match[2].trim();
      const isAbstract = new RegExp(`\\babstract\\s+class\\s+${serviceName}\\b`).test(content.slice(Math.max(0, match.index - 80), match.index + 120));
      const isHostedService = /\b(?:BackgroundService|IHostedService)\b/.test(inheritance);
      const isMessageWorker = /\b(?:IWorker|BaseEventBusWorker|Consumer|Listener)\b/.test(inheritance) ||
        /\bHandleEvent\s*\(/.test(content) ||
        /\bListenToQueue(?:Sync)?\s*</.test(content);

      if (!isHostedService && !isMessageWorker) continue;
      if (isAbstract && !isHostedService) continue;

      const classNode = this.findClassNode(nodes, serviceName, fullPath);
      if (classNode) {
        classNode.type = 'worker';
        classNode.subcategories = [...new Set([...(classNode.subcategories || []), 'background-service'])];
        classNode.metadata = {
          ...classNode.metadata,
          language: classNode.metadata?.language || 'csharp',
          framework: classNode.metadata?.framework || 'dotnet-host',
          attributes: {
            ...(classNode.metadata?.attributes || {}),
            dotnet_worker: true,
            message_worker: isMessageWorker,
            base_type: inheritance
          }
        };
      }

      const executeLine = this.lineNumberFor(content, /\bExecuteAsync\s*\(/);
      const executeNode = this.findMethodNode(nodes, serviceName, 'ExecuteAsync', fullPath);
      const handleEventLine = this.lineNumberFor(content, /\bHandleEvent\s*\(/);
      const handleEventNode = this.findMethodNode(nodes, serviceName, 'HandleEvent', fullPath);
      const startNode = this.findMethodNode(nodes, serviceName, 'StartAsync', fullPath);
      const handlerNode = executeNode || handleEventNode || startNode;
      const sourceNode = handlerNode?.id || classNode?.id || this.ensureSyntheticNode(nodes, edges, fullPath, relativeFile, serviceName, 'worker', match.index, content);
      const messageType = this.extractWorkerMessageType(inheritance);
      const queueName = this.extractQueueName(content);
      const serviceType = isMessageWorker ? 'message-worker' : 'background-service';
      this.pushUniqueEntryPoint(entryPoints, {
        id: `entry_dotnet_worker_${this.sanitizeId(relativeFile)}_${this.sanitizeId(serviceName)}`,
        source_node: sourceNode,
        source_analyzer: this.analyzerId,
        type: isMessageWorker ? 'message' : 'lifecycle',
        name: isMessageWorker ? `${serviceName} message worker` : `${serviceName} background worker`,
        description: isMessageWorker
          ? `${serviceName} handles queue/event messages in a .NET worker service.`
          : `${serviceName} runs as a .NET hosted background service.`,
        trigger: isMessageWorker
          ? { event: messageType || queueName || 'queue-message' }
          : { event: 'hosted-service-start' },
        handler: {
          node_id: sourceNode,
          method_name: executeNode ? 'ExecuteAsync' : handleEventNode ? 'HandleEvent' : startNode ? 'StartAsync' : serviceName,
          file: fullPath,
          line: handlerNode?.source?.line || executeLine || handleEventLine || this.lineNumberAtOffset(content, match.index)
        },
        input: messageType ? { type: messageType } : undefined,
        connected_nodes: [sourceNode, classNode?.id].filter(Boolean) as string[],
        metadata: {
          language: 'csharp',
          framework: 'dotnet-host',
          service_type: serviceType,
          message_type: messageType,
          queue_name: queueName,
          class_name: serviceName,
          file: relativeFile
        }
      });

      if (isMessageWorker && startNode && handleEventNode) {
        const edgeId = `message_dispatch_${startNode.id}_${handleEventNode.id}`;
        if (!edges.some(edge => edge.id === edgeId)) {
          edges.push(this.createEdge(edgeId, startNode.id, handleEventNode.id, 'dispatches', 'behavior', {
            message_type: messageType,
            queue_name: queueName,
            line: handleEventLine
          }));
        }
      }
    }
  }

  private extractWorkerMessageType(inheritance: string): string | undefined {
    const match = inheritance.match(/BaseEventBusWorker\s*<\s*([^,\s>]+)/);
    return match?.[1];
  }

  private extractQueueName(content: string): string | undefined {
    return content.match(/SoonQueue\.Create\s*\(\s*["']([^"']+)["']/)?.[1];
  }

  private getCSharpAttributeList(node: CASNode): string[] {
    const attributes = node.metadata?.attributes;
    if (Array.isArray(attributes)) return attributes;
    if (!attributes || typeof attributes !== 'object') return [];
    const csharpAttributes = (attributes as Record<string, unknown>).csharpAttributes;
    if (Array.isArray(csharpAttributes)) return csharpAttributes.filter((value): value is string => typeof value === 'string');
    return [];
  }

  private setMetadataAttribute(node: CASNode, key: string, value: unknown): void {
    node.metadata = node.metadata || {};
    if (!node.metadata.attributes || Array.isArray(node.metadata.attributes)) {
      node.metadata.attributes = { csharpAttributes: Array.isArray(node.metadata.attributes) ? node.metadata.attributes : [] };
    }
    (node.metadata.attributes as Record<string, unknown>)[key] = value;
  }

  private detectDotNetScheduledJobs(
    relativeFile: string,
    fullPath: string,
    content: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const patterns = [
      { regex: /\bRecurringJob\.AddOrUpdate\s*\(/g, name: 'Hangfire recurring job', schedule: 'hangfire-recurring-job' },
      { regex: /\bAddQuartzHostedService\s*\(/g, name: 'Quartz hosted scheduler', schedule: 'quartz-hosted-service' },
      { regex: /\bAddHostedService\s*<\s*([A-Za-z_][A-Za-z0-9_]*)\s*>\s*\(/g, name: 'Registered hosted service', schedule: 'hosted-service' },
      { regex: /\bTimer\s*\(/g, name: 'Timer scheduled callback', schedule: 'timer' },
    ];

    const fileNode = this.findFileNode(nodes, fullPath);
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(content)) !== null) {
        const line = this.lineNumberAtOffset(content, match.index);
        const nodeId = `schedule_${this.sanitizeId(relativeFile)}_${this.sanitizeId(pattern.schedule)}_${line}`;
        if (!nodes.some(node => node.id === nodeId)) {
          nodes.push(this.createNodeBuilder(nodeId, pattern.name, 'scheduler')
            .withLevel(3, this.getLevelName(3))
            .withSource({ file: fullPath, line })
            .withMetadata({
              language: 'csharp',
              framework: 'dotnet-host',
              attributes: {
                schedule_type: pattern.schedule,
                service_name: match[1]
              }
            })
            .withAnalyzers([this.analyzerId], this.analyzerId)
            .build());
          if (fileNode) edges.push(this.createEdge(`${fileNode.id}_contains_${nodeId}`, fileNode.id, nodeId, 'contains'));
        }
        this.pushUniqueEntryPoint(entryPoints, {
          id: `entry_dotnet_schedule_${this.sanitizeId(relativeFile)}_${this.sanitizeId(pattern.schedule)}_${line}`,
          source_node: nodeId,
          source_analyzer: this.analyzerId,
          type: 'schedule',
          name: pattern.name,
          description: `${pattern.name} is registered in .NET host configuration.`,
          trigger: { schedule: pattern.schedule },
          handler: {
            node_id: nodeId,
            method_name: match[1] || pattern.schedule,
            file: fullPath,
            line
          },
          metadata: {
            language: 'csharp',
            framework: 'dotnet-host',
            schedule_type: pattern.schedule,
            file: relativeFile
          }
        });
      }
    }
  }

  private detectAzureFunctions(
    relativeFile: string,
    fullPath: string,
    content: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[]
  ): void {
    const functionPattern = /\[(?:FunctionName|Function)\s*\(\s*"([^"]+)"\s*\)\][\s\S]{0,500}?\b(?:public\s+)?(?:async\s+)?(?:Task<[^>]+>|Task|IActionResult|void|[A-Za-z0-9_<>,]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = functionPattern.exec(content)) !== null) {
      const functionName = match[1];
      const methodName = match[2];
      const methodNode = this.findMethodNode(nodes, undefined, methodName, fullPath);
      const sourceNode = methodNode?.id || this.findFileNode(nodes, fullPath)?.id;
      if (!sourceNode) continue;
      const hasHttpTrigger = /\[HttpTrigger\b/.test(match[0]);
      this.pushUniqueEntryPoint(entryPoints, {
        id: `entry_azure_function_${this.sanitizeId(relativeFile)}_${this.sanitizeId(functionName)}`,
        source_node: sourceNode,
        source_analyzer: this.analyzerId,
        type: hasHttpTrigger ? 'http' : 'event',
        name: `Azure Function: ${functionName}`,
        description: `${functionName} is an Azure Functions entry point.`,
        trigger: hasHttpTrigger ? { method: 'ANY', path: functionName } : { event: 'azure-function-trigger' },
        handler: {
          node_id: sourceNode,
          method_name: methodName,
          file: fullPath,
          line: methodNode?.source?.line || this.lineNumberAtOffset(content, match.index)
        },
        metadata: {
          language: 'csharp',
          framework: 'azure-functions',
          function_name: functionName,
          file: relativeFile
        }
      });
    }
  }

  private findFileNode(nodes: CASNode[], fullPath: string): CASNode | undefined {
    const normalized = fullPath.replace(/\\/g, '/').toLowerCase();
    return nodes.find(node => node.type === 'file' && node.source?.file?.replace(/\\/g, '/').toLowerCase() === normalized);
  }

  private findClassNode(nodes: CASNode[], className: string, fullPath: string): CASNode | undefined {
    const normalized = fullPath.replace(/\\/g, '/').toLowerCase();
    return nodes.find(node =>
      node.name === className &&
      (node.type === 'class' || node.type === 'worker') &&
      node.source?.file?.replace(/\\/g, '/').toLowerCase() === normalized
    );
  }

  private findMethodNode(nodes: CASNode[], className: string | undefined, methodName: string, fullPath: string): CASNode | undefined {
    const normalized = fullPath.replace(/\\/g, '/').toLowerCase();
    return nodes.find(node =>
      node.type === 'method' &&
      node.name === methodName &&
      node.source?.file?.replace(/\\/g, '/').toLowerCase() === normalized &&
      (!className || nodes.find(parent => parent.id === node.parent)?.name === className)
    );
  }

  private ensureSyntheticNode(
    nodes: CASNode[],
    edges: CASEdge[],
    fullPath: string,
    relativeFile: string,
    name: string,
    type: string,
    offset: number,
    content: string
  ): string {
    const line = this.lineNumberAtOffset(content, offset);
    const nodeId = `${type}_${this.sanitizeId(relativeFile)}_${this.sanitizeId(name)}_${line}`;
    if (!nodes.some(node => node.id === nodeId)) {
      nodes.push(this.createNodeBuilder(nodeId, name, type)
        .withLevel(3, this.getLevelName(3))
        .withSource({ file: fullPath, line })
        .withMetadata({
          language: 'csharp',
          framework: 'dotnet-host'
        })
        .withAnalyzers([this.analyzerId], this.analyzerId)
        .build());
      const fileNode = this.findFileNode(nodes, fullPath);
      if (fileNode) edges.push(this.createEdge(`${fileNode.id}_contains_${nodeId}`, fileNode.id, nodeId, 'contains'));
    }
    return nodeId;
  }

  private pushUniqueEntryPoint(entryPoints: CASEntryPoint[], entryPoint: CASEntryPoint): void {
    if (entryPoints.some(existing => existing.id === entryPoint.id)) return;
    entryPoints.push(entryPoint);
  }

  private lineNumberFor(content: string, pattern: RegExp): number {
    const match = pattern.exec(content);
    return match ? this.lineNumberAtOffset(content, match.index) : 1;
  }

  private lineNumberAtOffset(content: string, offset: number): number {
    return content.slice(0, offset).split(/\r?\n/).length;
  }

  private offsetForLine(content: string, lineIndex: number): number {
    if (lineIndex <= 0) return 0;
    let offset = 0;
    for (let i = 0; i < lineIndex; i += 1) {
      const next = content.indexOf('\n', offset);
      if (next === -1) return content.length;
      offset = next + 1;
    }
    return offset;
  }

  private buildInheritanceRelationships(nodes: CASNode[], edges: CASEdge[]): void {
    const classNodes = nodes.filter(n => n.type === 'class' || n.type === 'worker');

    for (const classNode of classNodes) {
      if (classNode.metadata?.attributes?.baseClass) {
        const baseClassName = classNode.metadata.attributes.baseClass as string;
        const baseClassNode = classNodes.find(n => n.name === baseClassName);

        if (baseClassNode) {
          edges.push(this.createEdge(
            `${classNode.id}_inherits_${baseClassNode.id}`,
            classNode.id,
            baseClassNode.id,
            'inherits'
          ));
        }
      }

      if (classNode.metadata?.attributes?.implementedInterfaces) {
        const implementedInterfaces = classNode.metadata.attributes.implementedInterfaces as string[];
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

  private async buildProjectReferenceEdges(projectPath: string, nodes: CASNode[], edges: CASEdge[]): Promise<void> {
    const csprojFiles = await glob(['**/*.csproj'], {
      cwd: projectPath,
      ignore: this.getCSharpIgnorePatterns({ projectPath }),
      nodir: true
    });

    for (const csprojFile of csprojFiles) {
      const fullPath = `${projectPath}/${csprojFile}`;
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        const projectRefPattern = /<ProjectReference\s+Include="([^"]+)"/g;
        let match;

        const sourceProjectName = path.basename(csprojFile, '.csproj');
        const sourceNs = nodes.find(n => n.type === 'namespace' && n.name.toLowerCase().includes(sourceProjectName.toLowerCase()));

        while ((match = projectRefPattern.exec(content)) !== null) {
          const refPath = match[1].replace(/\\/g, '/');
          const targetProjectName = path.basename(refPath, '.csproj');
          const targetNs = nodes.find(n => n.type === 'namespace' && n.name.toLowerCase().includes(targetProjectName.toLowerCase()));

          if (sourceNs && targetNs) {
            const edgeId = `project_ref_${this.sanitizeId(sourceProjectName)}_to_${this.sanitizeId(targetProjectName)}`;
            if (!edges.some(e => e.id === edgeId)) {
              edges.push(this.createEdge(edgeId, sourceNs.id, targetNs.id, 'project-reference', 'structure', {
                source_project: sourceProjectName,
                target_project: targetProjectName,
                reference_path: refPath
              }));
            }
          }
        }
      } catch {}
    }
  }

  private buildInterfaceImplementationEdges(nodes: CASNode[], edges: CASEdge[]): void {
    const classNodes = nodes.filter(n => n.type === 'class' || n.type === 'worker' || n.type === 'service' || n.type === 'viewmodel' || n.type === 'window' || n.type === 'ui_component');
    const interfaceNodes = nodes.filter(n => n.type === 'interface');

    for (const classNode of classNodes) {
      const implementedInterfaces = classNode.metadata?.attributes?.implementedInterfaces as string[] || [];
      for (const ifaceName of implementedInterfaces) {
        const cleanName = ifaceName.replace(/<.*>/, '').trim();
        const interfaceNode = interfaceNodes.find(n => n.name === cleanName);
        if (interfaceNode) {
          const edgeId = `implements_${classNode.id}_${interfaceNode.id}`;
          if (!edges.some(e => e.id === edgeId)) {
            edges.push(this.createEdge(edgeId, classNode.id, interfaceNode.id, 'implements', 'structure', {
              interface_name: cleanName,
              class_name: classNode.name
            }));
          }
        }
      }
    }
  }

  private linkEnumUsages(nodes: CASNode[], edges: CASEdge[]): void {
    const enumNodes = nodes.filter(n => n.type === 'enum');
    const memberNodes = nodes.filter(n =>
      n.type === 'field' || n.type === 'property' || n.type === 'method'
    );

    for (const enumNode of enumNodes) {
      for (const member of memberNodes) {
        const memberType = member.metadata?.attributes?.type as string ||
                          member.metadata?.attributes?.returnType as string || '';
        if (memberType === enumNode.name || memberType.includes(`<${enumNode.name}>`) || memberType.includes(`${enumNode.name}?`)) {
          const edgeId = `uses_enum_${member.id}_${enumNode.id}`;
          if (!edges.some(e => e.id === edgeId)) {
            edges.push(this.createEdge(edgeId, member.id, enumNode.id, 'uses-type', 'structure', {
              enum_name: enumNode.name,
              usage_context: member.type
            }));
          }
        }
      }

      for (const method of memberNodes.filter(n => n.type === 'method')) {
        const params = method.metadata?.attributes?.parameters as Array<{type: string}> || [];
        if (params.some(p => p.type === enumNode.name)) {
          const edgeId = `param_uses_enum_${method.id}_${enumNode.id}`;
          if (!edges.some(e => e.id === edgeId)) {
            edges.push(this.createEdge(edgeId, method.id, enumNode.id, 'uses-type', 'structure', {
              enum_name: enumNode.name,
              usage_context: 'parameter'
            }));
          }
        }
      }
    }
  }

  private isSystemNamespace(namespace: string): boolean {
    const systemNamespaces = [
      'System', 'Microsoft', 'Windows', 'Collections', 'Linq',
      'Text', 'IO', 'Threading', 'Net', 'Security', 'Reflection',
      'Runtime', 'Diagnostics', 'ComponentModel', 'Configuration'
    ];

    return systemNamespaces.some(sys => namespace === sys || namespace.startsWith(`${sys}.`));
  }

  private async analyzeCallGraph(projectPath: string, nodes: CASNode[], edges: CASEdge[], exitPoints: CASExitPoint[]): Promise<void> {
    const csharpFiles = await glob(['**/*.cs'], {
      cwd: projectPath,
      ignore: this.getCSharpIgnorePatterns({ projectPath }, true),
      nodir: true
    });
    csharpFiles.sort();

    const methodNodes = nodes.filter(n => n.type === 'method');
    const classNodes = nodes.filter(n => n.type === 'class' || n.type === 'worker' || n.type === 'interface' || n.type === 'struct');
    const edgeIds = new Set(edges.map(edge => edge.id));
    const exitIds = new Set(exitPoints.map(exit => exit.id));
    const classIds = new Set(classNodes.map(node => node.id));
    const methodNodesById = new Map(methodNodes.map(node => [node.id, node]));
    const methodNodesByName = new Map<string, CASNode[]>();
    const classNodesByName = new Map<string, CASNode[]>();
    const methodNodesByFileAndName = new Map<string, CASNode[]>();
    const methodsByClassId = new Map<string, CASNode[]>();

    for (const method of methodNodes) {
      const byName = methodNodesByName.get(method.name) || [];
      byName.push(method);
      methodNodesByName.set(method.name, byName);
      if (method.source?.file) {
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

    const firstMethodByName = (name?: string) => name ? methodNodesByName.get(name)?.[0] : undefined;
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

    if (csharpFiles.length > 300) {
      const fallbackIndex = this.buildFallbackCallGraphIndex(edges, exitPoints, methodNodes, classNodes);
      for (const file of csharpFiles) {
        const fullPath = path.join(projectPath, file);
        await this.analyzeCallGraphFallback(fullPath, file, nodes, edges, exitPoints, methodNodes, classNodes, projectPath, fallbackIndex);
      }
      return;
    }

    for (const file of csharpFiles) {
      const fullPath = path.join(projectPath, file);

      const ast = await this.astRunner.parseCSharpAST(fullPath);
      if (!ast) {
        await this.analyzeCallGraphFallback(fullPath, file, nodes, edges, exitPoints, methodNodes, classNodes, projectPath);
        continue;
      }

      this.astCache.set(file, ast);
      const currentNamespace = ast.namespace || 'global';

      for (const child of ast.children || []) {
        if (child.kind === 'Method' && child.invocations) {
          const callerMethod = firstMethodByFileAndName(fullPath, child.name);

          if (!callerMethod) continue;

          for (const invocation of child.invocations) {
            let targetMethod: CASNode | undefined;

            if (invocation.target) {
              const targetClass = firstClassByName(invocation.target);
              if (targetClass) {
                targetMethod = firstMethodInClass(targetClass.id, invocation.method);
              }
            } else {
              targetMethod = firstMethodByName(invocation.method);
            }

            if (targetMethod && targetMethod.id !== callerMethod.id) {
              const callEdgeId = `call_${callerMethod.id}_to_${targetMethod.id}_line_${invocation.line}`;
              pushEdgeOnce(this.createEdge(
                  callEdgeId,
                  callerMethod.id,
                  targetMethod.id,
                  'calls',
                  'behavior',
                  {
                    line: invocation.line,
                    callType: invocation.target ? 'method' : 'static',
                    targetClass: invocation.target,
                    targetMethod: invocation.method
                  }
                ));
            } else if (this.isExternalLibraryCall(invocation.target || invocation.method, invocation.target ? invocation.method : '', currentNamespace)) {
              const exitId = `exit_call_${callerMethod.id}_${invocation.target || ''}_${invocation.method}_${invocation.line}`;
              pushExitOnce(this.createExitPoint(
                  exitId,
                  callerMethod.id,
                  'sdk',
                  invocation.target ? `External call: ${invocation.target}.${invocation.method}` : `External call: ${invocation.method}`,
                  `Library call to ${this.identifyCSharpLibrary(invocation.target || invocation.method)}`,
                  invocation.target ? { sdk: invocation.target } : undefined,
                  invocation.method ? { method: invocation.method } : undefined,
                  {
                    targetClass: invocation.target || invocation.method,
                    targetMethod: invocation.method,
                    line: invocation.line,
                    library: this.identifyCSharpLibrary(invocation.target || invocation.method)
                  }
                ));
            }
          }
        }
      }
      await this.analyzeCallGraphFallback(fullPath, file, nodes, edges, exitPoints, methodNodes, classNodes, projectPath);
    }
  }

  private buildFallbackCallGraphIndex(
    edges: CASEdge[],
    exitPoints: CASExitPoint[],
    methodNodes: CASNode[],
    classNodes: CASNode[]
  ): CSharpFallbackCallGraphIndex {
    const edgeIds = new Set(edges.map(edge => edge.id));
    const exitIds = new Set(exitPoints.map(exit => exit.id));
    const classIds = new Set(classNodes.map(node => node.id));
    const methodsInFileByPath = new Map<string, CASNode[]>();
    const methodNodesByName = new Map<string, CASNode[]>();
    const classNodesByName = new Map<string, CASNode[]>();
    const methodsByClassId = new Map<string, CASNode[]>();
    const classByMethodId = new Map<string, CASNode>();
    const methodNodesById = new Map(methodNodes.map(node => [node.id, node]));
    const classNodesById = new Map(classNodes.map(node => [node.id, node]));

    for (const method of methodNodes) {
      if (method.source?.file) {
        const methodsInFile = methodsInFileByPath.get(method.source.file) || [];
        methodsInFile.push(method);
        methodsInFileByPath.set(method.source.file, methodsInFile);
      }
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
        const method = methodNodesById.get(edge.target);
        const classNode = classNodesById.get(edge.source);
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

    return {
      edgeIds,
      exitIds,
      classIds,
      methodsInFileByPath,
      methodNodesByName,
      classNodesByName,
      methodsByClassId,
      classByMethodId,
      methodNodesById,
      classNodesById
    };
  }

  /**
   * Map each in-scope local/parameter variable to its declared C# type within a
   * method's line range, so a `recv.Method()` call resolves to recv's type only
   * (excluding same-name methods on other classes — the decoy). Sources:
   * parameters (`Account a`), `var x = new T()`, and `T x = …`.
   */
  private buildCSharpReceiverTypes(lines: string[], startLine: number, endLine: number): Map<string, string> {
    const m = new Map<string, string>();
    const lo = Math.max(0, startLine - 1);
    const hi = Math.min(lines.length, endLine);
    const baseType = (t: string) => t.replace(/<.*$/, '').split('.').pop()!.trim();
    for (let i = lo; i < hi; i++) {
      const ln = lines[i];
      // parameters: `(Type name`, `, Type name`, with optional ref/out/in/params
      for (const pm of ln.matchAll(/[(,]\s*(?:ref\s+|out\s+|in\s+|params\s+)?([A-Z][A-Za-z0-9_]*(?:<[^>)]+>)?)\s+([a-z_]\w*)\s*[,)]/g)) {
        m.set(pm[2], baseType(pm[1]));
      }
      // `var x = new T(` and `T x = new T(` / `T x = ` (declared type wins)
      for (const vm of ln.matchAll(/\bvar\s+(\w+)\s*=\s*new\s+([A-Z]\w*)/g)) m.set(vm[1], vm[2]);
      for (const vm of ln.matchAll(/\b([A-Z][A-Za-z0-9_]*(?:<[^>)]+>)?)\s+(\w+)\s*=\s*new\s+/g)) m.set(vm[2], baseType(vm[1]));
    }
    return m;
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
    sharedIndex?: CSharpFallbackCallGraphIndex
  ): Promise<void> {
    const fileData = await this.getCachedFile(fullPath);
    const { content, lines } = fileData;
    const currentNamespace = this.extractNamespace(content) || 'global';
    const localIndex = sharedIndex || this.buildFallbackCallGraphIndex(edges, exitPoints, methodNodes, classNodes);
    const {
      edgeIds,
      exitIds,
      methodsInFileByPath,
      methodNodesByName,
      classNodesByName,
      methodsByClassId,
      classByMethodId
    } = localIndex;
    const methodsInFile = methodsInFileByPath.get(fullPath) || [];
    // Lazily-built per-caller-method receiver variable -> declared type map.
    const receiverTypesByMethod = new Map<string, Map<string, string>>();

    const callerForLine = (line: number) => methodsInFile.find(n =>
      n.source?.line !== undefined && n.source.line <= line &&
      n.source?.end_line !== undefined && n.source.end_line >= line
    );
    const firstMethodByName = (name?: string) => name ? methodNodesByName.get(name)?.[0] : undefined;
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

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const callerMethodForLine = callerForLine(i + 1);

        if (callerMethodForLine) {
          const mediatorDispatches = Array.from(line.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.Send\s*\(\s*new\s+([A-Za-z_][A-Za-z0-9_]*(?:<[^>)]+>)?)/g));
          for (const dispatch of mediatorDispatches) {
            const commandName = dispatch[2].replace(/\s+/g, '');
            const targetId = this.ensureSyntheticNode(
              nodes,
              edges,
              fullPath,
              file,
              commandName,
              'command',
              this.offsetForLine(content, i) + dispatch.index,
              content
            );
            const edgeId = `call_${callerMethodForLine.id}_to_${targetId}_${i}`;
            pushEdgeOnce(this.createEdge(
                edgeId,
                callerMethodForLine.id,
                targetId,
                'calls',
                'behavior',
                {
                  line: i + 1,
                  method_name: 'Send',
                  target_method: commandName,
                  call_type: line.includes('await') ? 'async' : 'method',
                  resolution_type: 'synthetic',
                  target_type: 'message-command',
                  dispatcher: dispatch[1]
                }
              ));
          }

          const bareCalls = Array.from(line.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g))
            .filter(call => {
              const name = call[1];
              const previousChar = line[Math.max(0, (call.index || 0) - 1)];
              return !['if', 'for', 'while', 'switch', 'catch', 'using', 'return', 'new', 'await', 'typeof', 'nameof'].includes(name) &&
                previousChar !== '.' &&
                previousChar !== '<';
            });
          for (const call of bareCalls) {
            const methodName = call[1];
            const containingClass = classByMethodId.get(callerMethodForLine.id);
            const targetMethod = containingClass
              ? firstMethodInClass(containingClass.id, methodName)
              : firstMethodByName(methodName);
            if (targetMethod && targetMethod.id !== callerMethodForLine.id) {
              const callEdgeId = `call_${callerMethodForLine.id}_to_${targetMethod.id}_line_${i + 1}`;
              pushEdgeOnce(this.createEdge(
                  callEdgeId,
                  callerMethodForLine.id,
                  targetMethod.id,
                  'calls',
                  'behavior',
                  {
                    line: i + 1,
                    callType: 'static',
                    targetMethod: methodName
                  }
                ));
            }
          }
        }

        const methodCalls = [
          ...Array.from(line.matchAll(/(\w+)\.(\w+)\s*\(/g)),
          ...Array.from(line.matchAll(/new\s+(\w+)\s*\(/g)).map(m => [m[0], m[1], 'ctor']),
          ...Array.from(line.matchAll(/(\w+)\s*\.\s*(\w+)\s*\(/g)),
          ...Array.from(line.matchAll(/base\.(\w+)\s*\(/g)).map(m => [m[0], 'base', m[1]]),
          ...Array.from(line.matchAll(/this\.(\w+)\s*\(/g)).map(m => [m[0], 'this', m[1]]),
          ...Array.from(line.matchAll(/await\s+(\w+)\.(\w+)\s*\(/g)),
          ...Array.from(line.matchAll(/(\w+)\s*\?\.\s*(\w+)\s*\(/g))
        ];

        const linqOperations = [
          ...Array.from(line.matchAll(/\.(?:Where|Select|OrderBy|GroupBy|Join|Take|Skip|First|Last|Any|All|Count|Sum)\s*\(/g))
        ];

        for (const match of methodCalls) {
          const fullMatch = match[0];
          const objectOrClass = match[1];
          const methodName = match[2];

          const callerMethod = callerMethodForLine;

          if (callerMethod) {
            let targetMethod: CASNode | undefined;

            if (objectOrClass === 'this' || objectOrClass === 'base') {
              const containingClass = classByMethodId.get(callerMethod.id);

              if (containingClass) {
                const className = objectOrClass === 'base' && containingClass.metadata?.attributes?.baseClass
                  ? containingClass.metadata.attributes.baseClass
                  : containingClass.name;

                const targetClass = firstClassByName(className);
                targetMethod = targetClass ? firstMethodInClass(targetClass.id, methodName) : undefined;
              }
            } else if (fullMatch.startsWith('new ')) {
              const targetClass = firstClassByName(objectOrClass);
              if (targetClass) {
                targetMethod = (methodsByClassId.get(targetClass.id) || []).find(n => n.metadata?.attributes?.isConstructor);
              }
            } else {
              // Receiver-type resolution: if `objectOrClass` is a local/param whose
              // declared type we know, resolve to THAT type's method only (excludes
              // same-name decoys). Else if it names a class, treat as a static call.
              // Else fall back to name resolution (never lose a real edge).
              const recvMap = receiverTypesByMethod.get(callerMethod.id)
                || (receiverTypesByMethod.set(callerMethod.id,
                    this.buildCSharpReceiverTypes(lines, callerMethod.source?.line ?? 1, callerMethod.source?.end_line ?? lines.length)),
                    receiverTypesByMethod.get(callerMethod.id)!);
              const recvType = recvMap.get(objectOrClass);
              if (recvType) {
                const targetClass = firstClassByName(recvType);
                targetMethod = targetClass ? firstMethodInClass(targetClass.id, methodName) : undefined;
              } else {
                const asClass = firstClassByName(objectOrClass);
                if (asClass) {
                  targetMethod = firstMethodInClass(asClass.id, methodName);
                } else {
                  targetMethod = firstMethodByName(methodName);
                }
              }
            }

            if (targetMethod) {
              const callEdgeId = `call_${callerMethod.id}_to_${targetMethod.id}_${i}`;
              pushEdgeOnce(this.createEdge(
                  callEdgeId,
                  callerMethod.id,
                  targetMethod.id,
                  'calls',
                  'behavior',
                  {
                    line: i + 1,
                    callType: fullMatch.startsWith('new ') ? 'constructor' :
                             fullMatch.includes('await') ? 'async' :
                             objectOrClass === 'base' ? 'base' :
                             objectOrClass === 'this' ? 'internal' :
                             fullMatch.includes('?.') ? 'null-conditional' : 'method'
                  }
                ));
            } else if (this.isExternalLibraryCall(objectOrClass, methodName, currentNamespace)) {
              const exitId = `exit_call_${callerMethod.id}_${objectOrClass}_${methodName}_${i}`;
              pushExitOnce(this.createExitPoint(
                  exitId,
                  callerMethod.id,
                  'sdk',
                  `External call: ${objectOrClass}.${methodName}`,
                  `Library call to ${this.identifyCSharpLibrary(objectOrClass)}`,
                  undefined,
                  undefined,
                  {
                    targetClass: objectOrClass,
                    targetMethod: methodName,
                    line: i + 1,
                    library: this.identifyCSharpLibrary(objectOrClass),
                    isAsync: fullMatch.includes('await')
                  }
                ));
            }
          }
        }

        for (const linqOp of linqOperations) {
          const operation = linqOp[0].slice(1).replace(/\s*\(/, '');
          const callerMethod = callerMethodForLine;

          if (callerMethod) {
            const exitId = `exit_linq_${callerMethod.id}_${operation}_${i}`;
            pushExitOnce(this.createExitPoint(
                exitId,
                callerMethod.id,
                'sdk',
                `LINQ operation: ${operation}`,
                'LINQ query operation',
                undefined,
                undefined,
                {
                  operation,
                  line: i + 1,
                  library: 'System.Linq'
                }
              ));
          }
        }

        const httpAttributes = [
          ...Array.from(line.matchAll(/\[(?:HttpGet|HttpPost|HttpPut|HttpDelete|HttpPatch|Route)\s*(?:\(\s*["']([^"']+)["']\s*\))?\]/g))
        ];

        for (const attr of httpAttributes) {
          const route = attr[1] || '';
          const attributeType = attr[0].match(/\[(\w+)/)?.[1];

          const nextMethodLine = this.findNextMethodDeclaration(lines, i);
          if (nextMethodLine !== -1) {
            const methodAtLine = methodsInFile.find(n => n.source?.line === nextMethodLine + 1);

            if (methodAtLine && attributeType) {
              const endpointEdgeId = `http_endpoint_${methodAtLine.id}_${attributeType}_${i}`;
              if (!edgeIds.has(endpointEdgeId)) {
                const sourceNode = methodAtLine.parent || methodAtLine.id;
                pushEdgeOnce(this.createEdge(
                  endpointEdgeId,
                  sourceNode,
                  methodAtLine.id,
                  'exposes',
                  'behavior',
                  {
                    httpMethod: attributeType.replace('Http', '').toUpperCase(),
                    route,
                    attribute: `[${attributeType}]`
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
    const methodPattern = /^(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|extern|unsafe|sealed|new|partial)\s+)*(?:[\w.<>,?\[\]]+\s+)?[A-Za-z_~][A-Za-z0-9_~]*\s*\([^)]*\)\s*(?:\{|=>|;|$)/;
    return methodPattern.test(trimmed) && !trimmed.startsWith('//');
  }

  private isExternalLibraryCall(objectOrClass: string, methodName: string, currentNamespace: string): boolean {
    const systemTypes = [
      'Console', 'String', 'Int32', 'Double', 'Decimal', 'DateTime', 'TimeSpan',
      'Math', 'Array', 'List', 'Dictionary', 'HashSet', 'Queue', 'Stack',
      'File', 'Directory', 'Path', 'Stream', 'StreamReader', 'StreamWriter',
      'Task', 'HttpClient', 'WebRequest', 'JsonSerializer',
      // Device / hardware I/O BCL types — a bare `SerialPort` receiver (e.g.
      // `SerialPort.GetPortNames()`, `new SerialPort(...)`) is a real external
      // call to System.IO.Ports, but bare has no dotted prefix so the generic
      // rules below miss it. Recognizing it lets an exit point be emitted, which
      // the communication-seam layer then classifies as a device_io seam.
      'SerialPort'
    ];

    const frameworkTypes = [
      'DbContext', 'DbSet', 'Controller', 'ActionResult', 'ViewResult',
      'ILogger', 'IConfiguration', 'IServiceCollection', 'IServiceProvider',
      'HttpContext', 'HttpRequest', 'HttpResponse'
    ];

    return systemTypes.includes(objectOrClass) ||
           frameworkTypes.includes(objectOrClass) ||
           objectOrClass.startsWith('System.') ||
           objectOrClass.startsWith('Microsoft.') ||
           (!objectOrClass.startsWith(currentNamespace) && objectOrClass.includes('.'));
  }

  private identifyCSharpLibrary(className: string): string {
    if (className.startsWith('System.Collections')) return 'System.Collections';
    if (className.startsWith('System.IO.Ports')) return 'System.IO.Ports';
    if (className.startsWith('System.IO')) return 'System.IO';
    if (className.startsWith('System.Net')) return 'System.Net';
    if (className.startsWith('System.Threading')) return 'System.Threading';
    if (className.startsWith('System.Linq')) return 'System.Linq';
    if (className.startsWith('Microsoft.EntityFrameworkCore')) return 'Entity Framework Core';
    if (className.startsWith('Microsoft.AspNetCore')) return 'ASP.NET Core';

    const standardTypes: Record<string, string> = {
      'Console': 'System',
      'String': 'System',
      'Math': 'System',
      'DateTime': 'System',
      'File': 'System.IO',
      'Directory': 'System.IO',
      'Path': 'System.IO',
      'HttpClient': 'System.Net.Http',
      'Task': 'System.Threading.Tasks',
      'List': 'System.Collections.Generic',
      'Dictionary': 'System.Collections.Generic',
      'DbContext': 'Entity Framework Core',
      'Controller': 'ASP.NET Core MVC',
      'ILogger': 'Microsoft.Extensions.Logging',
      'SerialPort': 'System.IO.Ports'
    };

    return standardTypes[className] || 'External Library';
  }

  private extractDocumentationFromXmlComment(lines: string[], lineIndex: number): CASDocumentation | undefined {
    const docs: CASDocumentation = {
      id: `doc_${lineIndex}`,
      format: 'xml_doc',
      raw: '',
      location: { start_line: lineIndex, end_line: lineIndex }
    };
    let hasContent = false;

    for (let i = lineIndex - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith('///')) break;

      const xmlContent = line.replace(/^\/\/\/\s*/, '');

      const summaryMatch = xmlContent.match(/<summary>\s*(.*?)\s*<\/summary>/);
      if (summaryMatch) {
        docs.summary = summaryMatch[1];
        hasContent = true;
      } else if (xmlContent.includes('<summary>')) {
        docs.summary = xmlContent.replace('<summary>', '').trim();
        hasContent = true;
      } else if (docs.summary && xmlContent.includes('</summary>')) {
        docs.summary = (docs.summary + ' ' + xmlContent.replace('</summary>', '')).trim();
      } else if (docs.summary && !xmlContent.includes('<')) {
        docs.summary = (docs.summary + ' ' + xmlContent).trim();
      }

      const paramMatch = xmlContent.match(/<param name=\"([^\"]+)\">\s*(.*?)\s*<\/param>/);
      if (paramMatch) {
        if (!docs.parameters) docs.parameters = [];
        docs.parameters.push({
          name: paramMatch[1],
          description: paramMatch[2]
        });
        hasContent = true;
      }

      const returnsMatch = xmlContent.match(/<returns>\s*(.*?)\s*<\/returns>/);
      if (returnsMatch) {
        docs.returns = { description: returnsMatch[1] };
        hasContent = true;
      }

      const exceptionMatch = xmlContent.match(/<exception cref=\"([^\"]+)\">\s*(.*?)\s*<\/exception>/);
      if (exceptionMatch) {
        if (!docs.exceptions) docs.exceptions = [];
        docs.exceptions.push({
          type: exceptionMatch[1],
          description: exceptionMatch[2]
        });
        hasContent = true;
      }

      const remarksMatch = xmlContent.match(/<remarks>\s*(.*?)\s*<\/remarks>/);
      if (remarksMatch) {
        docs.remarks = remarksMatch[1];
        hasContent = true;
      }

      const exampleMatch = xmlContent.match(/<example>\s*(.*?)\s*<\/example>/);
      if (exampleMatch) {
        if (!docs.examples) docs.examples = [];
        docs.examples.push({ code: exampleMatch[1] });
        hasContent = true;
      }
    }

    return hasContent ? docs : undefined;
  }

  private extractCommentsFromFile(content: string, filePath: string): CASComment[] {
    const comments: CASComment[] = [];
    let commentSeq = 0;
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const singleLineMatch = line.match(/\/\/(.*)$/);
      if (singleLineMatch && !line.trim().startsWith('///')) {
        const text = singleLineMatch[1].trim();
        const purpose = this.classifyCommentPurpose(text);
        comments.push({
          id: `comment_${filePath}_${++commentSeq}`,
          type: 'single-line',
          style: '//',
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

      if (line.includes('/*')) {
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

  private detectImplementationStatus(methodInfo: CSharpMethod, methodBody: string[]): CASImplementationStatus {
    const bodyText = methodBody.join('\n').toLowerCase();

    if (bodyText.includes('throw new notimplementedexception') ||
        bodyText.includes('notimplemented')) {
      return {
        status: 'not-implemented',
        indicators: ['NotImplementedException thrown'],
        confidence: 1.0
      };
    }

    if (methodInfo.attributes.some(attr => attr.toLowerCase().includes('obsolete'))) {
      return {
        status: 'deprecated',
        indicators: ['[Obsolete] attribute'],
        confidence: 1.0
      };
    }

    if (bodyText.includes('todo') || bodyText.includes('fixme')) {
      return {
        status: 'partial',
        indicators: ['Contains TODO/FIXME markers'],
        confidence: 0.7
      };
    }

    if (methodBody.length <= 2 && (bodyText.includes('return') || bodyText.includes('throw'))) {
      return {
        status: 'stub',
        indicators: ['Simple return or throw statement'],
        confidence: 0.6
      };
    }

    return {
      status: 'complete',
      indicators: ['Standard implementation'],
      confidence: 0.8
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
      'method-detection',
      'interface-mapping',
      'inheritance-tracking',
      'attribute-parsing',
      'namespace-organization',
      'aspnet-core-detection',
      'entity-framework-detection'
    ];
  }
}
