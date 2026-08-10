import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  CASDocumentation, CASComment, CASTodo, CASImplementationStatus, FileAnalysisResult
} from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import { isAuthenticationGuardName } from '../core/guard-classification';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';
import { TreeSitterParser } from '../core/tree-sitter-parser';
import type { GoASTNode } from '../core/ast-types';
import * as path from 'path';

interface GoStruct {
  name: string;
  packageName: string;
  filePath: string;
  fields: GoField[];
  methods: GoMethod[];
  tags: string[];
  embedded: string[];
  lineStart: number;
  lineEnd: number;
  isExported: boolean;
}

interface GoInterface {
  name: string;
  packageName: string;
  filePath: string;
  methods: GoMethod[];
  embedded: string[];
  lineStart: number;
  lineEnd: number;
  isExported: boolean;
}

interface GoFunction {
  name: string;
  packageName: string;
  filePath: string;
  parameters: GoParameter[];
  returnTypes: string[];
  receiver?: GoReceiver;
  lineStart: number;
  lineEnd: number;
  isExported: boolean;
  isMain: boolean;
  isInit: boolean;
}

interface GoMethod {
  name: string;
  parameters: GoParameter[];
  returnTypes: string[];
  receiver?: GoReceiver;
  lineStart: number;
  lineEnd: number;
  isExported: boolean;
}

interface GoParameter {
  name: string;
  type: string;
  isVariadic: boolean;
}

interface GoReceiver {
  name: string;
  type: string;
  isPointer: boolean;
}

interface GoField {
  name: string;
  type: string;
  tag?: string;
  lineNumber: number;
  isExported: boolean;
  isEmbedded: boolean;
}

interface GoImport {
  path: string;
  alias?: string;
  lineNumber: number;
  isStandard: boolean;
  isDotImport: boolean;
  isBlankImport: boolean;
}

interface GoVariable {
  name: string;
  type?: string;
  value?: string;
  lineNumber: number;
  isExported: boolean;
  isConst: boolean;
  scope: 'package' | 'function' | 'block';
}

interface GoConstant {
  name: string;
  type?: string;
  value?: string;
  lineNumber: number;
  isExported: boolean;
  iota?: boolean;
}

interface GoType {
  name: string;
  packageName: string;
  filePath: string;
  underlying: string;
  methods: GoMethod[];
  lineNumber: number;
  isExported: boolean;
}

export class GoAnalyzer extends BaseAnalyzer {
  private ginFrameworkDetected = false;
  private echoFrameworkDetected = false;
  private gorillaFrameworkDetected = false;
  private fiberFrameworkDetected = false;
  private goModulesProject = false;
  private vendorProject = false;
  private astRunner: TreeSitterParser;
  private astCache = new Map<string, GoASTNode>();

  constructor() {
    super(
      'go',
      'Go Language Analyzer',
      '1.0.0',
      'language'
    );
    this.astRunner = new TreeSitterParser();
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const goFiles = await glob(['**/*.go'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true
      });

      const projectFiles = await glob(['go.mod', 'go.sum', 'Gopkg.toml'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true
      });

      return goFiles.length > 0 || projectFiles.length > 0;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await glob(['**/*.go'], {
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
    const packages = new Map<string, string[]>();
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    await this.detectProjectType(context.projectPath);
    await this.analyzeGoFile(context.filePath, context.relativePath, nodes, edges, entryPoints, exitPoints, packages, context);
    this.detectFrameworkPatterns(nodes, edges, entryPoints);
    this.buildTypeRelationships(nodes, edges);
    this.applyTestFileBoundary(nodes);
    await this.analyzeCallGraph(context.projectPath, nodes, edges, exitPoints);

    const imports = this.extractImports(content).map(imp => imp.path);
    const exports = nodes
      .filter(node => ['struct', 'interface', 'function', 'method', 'type', 'variable', 'constant'].includes(node.type))
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
    const libraries: any[] = [];

    try {
      await this.detectProjectType(context.projectPath);
      await this.extractDependencies(context.projectPath, libraries);

      const goFiles = this.capAndPrioritizeSourceFiles(await glob(['**/*.go'], {
        cwd: context.projectPath,
        ignore: this.getIgnorePatterns(context),
        nodir: true
      }), 'Go files');
      goFiles.sort();

      const packages = new Map<string, string[]>();

      for (const file of goFiles) {
        const fullPath = `${context.projectPath}/${file}`;
        await this.analyzeGoFile(fullPath, file, nodes, edges, entryPoints, exitPoints, packages, context);
      }

      this.buildPackageHierarchy(packages, nodes, edges);
      this.detectFrameworkPatterns(nodes, edges, entryPoints);
      this.buildTypeRelationships(nodes, edges);
      this.applyTestFileBoundary(nodes);

      if (this.shouldBuildExpensiveLanguageCallGraph(goFiles.length)) {
        await this.analyzeCallGraph(context.projectPath, nodes, edges, exitPoints);
      } else {
        this.addAnalysisWarning(
          `Go cross-file call graph deferred for ${process.env.KLAURO_ANALYSIS_FOCUS || 'default'} focus after ${goFiles.length} prioritized files; run deep-context/full analysis for exhaustive Go call edges`
        );
      }

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          language: 'go',
          ginFramework: this.ginFrameworkDetected,
          echoFramework: this.echoFrameworkDetected,
          gorillaFramework: this.gorillaFrameworkDetected,
          fiberFramework: this.fiberFrameworkDetected,
          packageManager: this.goModulesProject ? 'go_modules' : this.vendorProject ? 'vendor' : 'go_get',
          libraries,
          filesAnalyzed: goFiles.length,
          packagesFound: packages.size
        }
      });

    } catch (error) {
      throw new AnalyzerError(
        `Go analysis failed: ${(error as Error).message}`,
        'GO_ANALYSIS_ERROR'
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
    const goModPath = `${projectPath}/go.mod`;
    const vendorPath = `${projectPath}/vendor`;

    this.goModulesProject = await fs.pathExists(goModPath);
    this.vendorProject = await fs.pathExists(vendorPath);

    if (this.goModulesProject) {
      try {
        const goModContent = await fs.readFile(goModPath, 'utf-8');
        this.detectFrameworks(goModContent);
      } catch (error) {
        console.warn('Failed to read go.mod:', error);
      }
    }
  }

  private detectFrameworks(content: string): void {
    this.ginFrameworkDetected = this.ginFrameworkDetected ||
      content.includes('github.com/gin-gonic/gin');

    this.echoFrameworkDetected = this.echoFrameworkDetected ||
      content.includes('github.com/labstack/echo');

    this.gorillaFrameworkDetected = this.gorillaFrameworkDetected ||
      content.includes('github.com/gorilla/mux');

    this.fiberFrameworkDetected = this.fiberFrameworkDetected ||
      content.includes('github.com/gofiber/fiber');
  }

  private async extractDependencies(projectPath: string, libraries: any[]): Promise<void> {
    const goModPath = `${projectPath}/go.mod`;
    const goSumPath = `${projectPath}/go.sum`;

    if (await fs.pathExists(goModPath)) {
      await this.extractGoModDependencies(goModPath, libraries);
    }

    if (await fs.pathExists(goSumPath)) {
      await this.extractGoSumDependencies(goSumPath, libraries);
    }
  }

  private async extractGoModDependencies(goModPath: string, libraries: any[]): Promise<void> {
    try {
      const goModContent = await fs.readFile(goModPath, 'utf-8');
      const lines = goModContent.split('\n');
      let inRequireBlock = false;

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === 'require (') {
          inRequireBlock = true;
          continue;
        }

        if (trimmed === ')') {
          inRequireBlock = false;
          continue;
        }

        const requireMatch = trimmed.match(/^require\s+([^\s]+)\s+([^\s]+)/);
        if (requireMatch) {
          libraries.push({
            name: requireMatch[1],
            version: requireMatch[2],
            type: 'go_module',
            source: 'go.mod',
            metadata: {
              isProduction: true,
              isDirect: true
            }
          });
          continue;
        }

        if (inRequireBlock && trimmed) {
          const blockMatch = trimmed.match(/^([^\s]+)\s+([^\s]+)/);
          if (blockMatch) {
            libraries.push({
              name: blockMatch[1],
              version: blockMatch[2],
              type: 'go_module',
              source: 'go.mod',
              metadata: {
                isProduction: true,
                isDirect: true
              }
            });
          }
        }
      }
    } catch (error) {
      console.warn('Failed to parse go.mod:', error);
    }
  }

  private async extractGoSumDependencies(goSumPath: string, libraries: any[]): Promise<void> {
    try {
      const goSumContent = await fs.readFile(goSumPath, 'utf-8');
      const lines = goSumContent.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          const sumMatch = trimmed.match(/^([^\s]+)\s+([^\s]+)\s+([^\s]+)/);
          if (sumMatch) {
            const existingLib = libraries.find(lib => lib.name === sumMatch[1] && lib.version === sumMatch[2]);
            if (existingLib) {
              existingLib.metadata.checksum = sumMatch[3];
            }
          }
        }
      }
    } catch (error) {
      console.warn('Failed to parse go.sum:', error);
    }
  }

  private async analyzeGoFile(
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
      const structs = this.extractStructs(content, relativePath);
      const interfaces = this.extractInterfaces(content, relativePath);
      const functions = this.extractFunctions(content, relativePath);
      const types = this.extractTypes(content, relativePath);
      const variables = this.extractVariables(content);
      const constants = this.extractConstants(content);

      if (packageName) {
        if (!packages.has(packageName)) {
          packages.set(packageName, []);
        }
        packages.get(packageName)!.push(relativePath);
      }

      const fileId = `file_${this.sanitizeId(relativePath)}`;
      const fileComments = this.extractCommentsFromFile(content, relativePath);
      const fileTodos = this.extractTodosFromComments(fileComments, relativePath);

      nodes.push(this.createNodeBuilder(
        fileId,
        relativePath.split('/').pop() || 'unknown.go',
        'file'
      )
        .withLevel(1, 'File/Module')
        .withCategory('modules', ['go-files'])
        .withSource({ file: relativePath, line: 1, end_line: lines.length })
        .withMetadata({
          language: 'go',
          attributes: {
            packageName: packageName || 'main',
            imports: imports.map(i => i.path),
            structCount: structs.length,
            interfaceCount: interfaces.length,
            functionCount: functions.length,
            typeCount: types.length,
            variableCount: variables.length,
            constantCount: constants.length,
            extension: '.go',
            commentCount: fileComments.length,
            todoCount: fileTodos.length
          }
        })
        .withComments(fileComments.length > 0 ? fileComments : undefined)
        .withTodos(fileTodos.length > 0 ? fileTodos : undefined)
        .build());

      // HTTP routes from Go web frameworks (Gin / Echo / Gorilla mux / net/http) —
      // the Camp-C route fact Camp A/B can't produce. Emitted as http entry points
      // with a trigger so buildRouteTable surfaces method + path.
      this.extractGoHttpRoutes(content, fileId, relativePath, entryPoints);

      for (const imp of imports) {
        const importId = `import_${fileId}_${this.sanitizeId(imp.path)}`;
        nodes.push(this.createNodeBuilder(
          importId,
          imp.alias || imp.path,
          'import'
        )
          .withLevel(2, 'Import/Dependency')
          .withCategory('imports', ['go-imports'])
          .withSource({ file: relativePath, line: imp.lineNumber })
          .withMetadata({
            language: 'go',
            attributes: {
              path: imp.path,
              alias: imp.alias,
              isStandard: imp.isStandard,
              isDotImport: imp.isDotImport,
              isBlankImport: imp.isBlankImport,
              packageType: imp.isStandard ? 'standard' : 'external'
            }
          })
          .build());

        edges.push(this.createEdge(
          `${fileId}_imports_${importId}`,
          fileId,
          importId,
          'imports'
        ));

        if (!imp.isStandard) {
          exitPoints.push({
            id: `exit_${importId}`,
            name: `External package: ${imp.path}`,
            type: 'external_package',
            source_node: importId,
            metadata: { path: imp.path }
          });
        }
      }

      for (const struct of structs) {
        await this.processGoStruct(struct, fileId, fullPath, relativePath, nodes, edges, entryPoints);
      }

      for (const intf of interfaces) {
        await this.processGoInterface(intf, fileId, fullPath, relativePath, nodes, edges, entryPoints);
      }

      for (const func of functions) {
        await this.processGoFunction(func, fileId, fullPath, relativePath, nodes, edges, entryPoints);
      }

      for (const type of types) {
        await this.processGoType(type, fileId, fullPath, relativePath, nodes, edges, entryPoints);
      }

      for (const variable of variables) {
        const variableId = `variable_${fileId}_${this.sanitizeId(variable.name)}`;
        nodes.push(this.createNodeBuilder(
          variableId,
          variable.name,
          'variable'
        )
          .withLevel(3, 'Variable/Property')
          .withCategory('data', ['go-variables'])
          .withSource({ file: relativePath, line: variable.lineNumber })
          .withMetadata({
            language: 'go',
            is_exported: variable.isExported,
            attributes: {
              type: variable.type,
              value: variable.value,
              isConst: variable.isConst,
              scope: variable.scope,
              variableType: variable.type
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
        nodes.push(this.createNodeBuilder(
          constantId,
          constant.name,
          'constant'
        )
          .withLevel(3, 'Constant/Property')
          .withCategory('data', ['go-constants'])
          .withSource({ file: relativePath, line: constant.lineNumber })
          .withMetadata({
            language: 'go',
            is_exported: constant.isExported,
            attributes: {
              type: constant.type,
              value: constant.value,
              iota: constant.iota,
              constantType: constant.type
            }
          })
          .build());

        edges.push(this.createEdge(
          `${fileId}_contains_${constantId}`,
          fileId,
          constantId,
          'contains'
        ));
      }

    } catch (error) {
      console.warn(`Failed to analyze Go file ${relativePath}:`, error);
    }
  }

  private async processGoStruct(
    struct: GoStruct,
    fileId: string,
    fullPath: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const structId = `struct_${this.sanitizeId(struct.packageName)}_${this.sanitizeId(struct.name)}`;
    const content = await fs.readFile(fullPath, 'utf-8');
    const structComments = this.extractCommentsFromFile(content, relativePath).filter(c =>
      c.location.line >= struct.lineStart - 3 && c.location.line <= struct.lineStart
    );
    const structTodos = this.extractTodosFromComments(structComments, structId);
    const structDocs = this.extractDocumentationFromGoDoc(
      content.split('\n'),
      struct.lineStart - 1
    );

    nodes.push(this.createNodeBuilder(
      structId,
      struct.name,
      'struct'
    )
      .withLevel(2, 'Class/Interface')
      .withCategory('structures', ['go-structs'])
      .withSource({ file: relativePath, line: struct.lineStart, end_line: struct.lineEnd })
      .withMetadata({
        language: 'go',
        is_exported: struct.isExported,
        attributes: {
          packageName: struct.packageName,
          fieldCount: struct.fields.length,
          methodCount: struct.methods.length,
          tags: struct.tags,
          embedded: struct.embedded,
          hasDocumentation: !!structDocs
        }
      })
      .withDocumentation(structDocs)
      .withComments(structComments.length > 0 ? structComments : undefined)
      .withTodos(structTodos.length > 0 ? structTodos : undefined)
      .build());

    edges.push(this.createEdge(
      `${fileId}_contains_${structId}`,
      fileId,
      structId,
      'contains'
    ));

    for (const field of struct.fields) {
      const fieldId = `field_${structId}_${this.sanitizeId(field.name)}`;
      nodes.push(this.createNodeBuilder(
        fieldId,
        field.name,
        'field'
      )
        .withLevel(4, 'Field/Property')
        .withCategory('data', ['struct-fields'])
        .withSource({ file: relativePath, line: field.lineNumber })
        .withMetadata({
          language: 'go',
          is_exported: field.isExported,
          attributes: {
            type: field.type,
            tag: field.tag,
            isEmbedded: field.isEmbedded,
            fieldType: field.type
          }
        })
        .withParent(structId)
        .build());

      edges.push(this.createEdge(
        `${structId}_has_field_${fieldId}`,
        structId,
        fieldId,
        'has_field'
      ));
    }

    for (const method of struct.methods) {
      const methodId = `method_${structId}_${this.sanitizeId(method.name)}_${method.lineStart}`;
      const methodDocs = this.extractDocumentationFromGoDoc(
        content.split('\n'),
        method.lineStart - 1
      );
      const methodComments = this.extractCommentsFromFile(content, relativePath).filter(c =>
        c.location.line >= method.lineStart && c.location.line <= method.lineEnd
      );
      const methodTodos = this.extractTodosFromComments(methodComments, methodId);

      nodes.push(this.createNodeBuilder(
        methodId,
        method.name,
        'method'
      )
        .withLevel(4, 'Method/Function')
        .withCategory('methods', ['struct-methods'])
        .withSource({ file: relativePath, line: method.lineStart, end_line: method.lineEnd })
        .withMetadata({
          is_exported: method.isExported,
          attributes: {
            receiver: method.receiver,
            parameterCount: method.parameters.length,
            returnTypeCount: method.returnTypes.length,
            hasDocumentation: !!methodDocs
          }
        })
        .withSignature({
          parameters: method.parameters,
          return_type: method.returnTypes.join(', ')
        })
        .withParent(structId)
        .withDocumentation(methodDocs)
        .withComments(methodComments.length > 0 ? methodComments : undefined)
        .withTodos(methodTodos.length > 0 ? methodTodos : undefined)
        .build());

      edges.push(this.createEdge(
        `${structId}_has_method_${methodId}`,
        structId,
        methodId,
        'has_method'
      ));
    }

    if (struct.isExported) {
      entryPoints.push({
        id: `entry_${structId}`,
        name: `Exported struct: ${struct.name}`,
        type: 'exported_struct',
        source_node: structId,
        metadata: {
          packageName: struct.packageName,
          structName: struct.name,
          tags: struct.tags
        }
      });
    }
  }

  private async processGoInterface(
    intf: GoInterface,
    fileId: string,
    fullPath: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const interfaceId = `interface_${this.sanitizeId(intf.packageName)}_${this.sanitizeId(intf.name)}`;
    const content = await fs.readFile(fullPath, 'utf-8');
    const interfaceComments = this.extractCommentsFromFile(content, relativePath).filter(c =>
      c.location.line >= intf.lineStart - 3 && c.location.line <= intf.lineStart
    );
    const interfaceTodos = this.extractTodosFromComments(interfaceComments, interfaceId);
    const interfaceDocs = this.extractDocumentationFromGoDoc(
      content.split('\n'),
      intf.lineStart - 1
    );

    nodes.push(this.createNodeBuilder(
      interfaceId,
      intf.name,
      'interface'
    )
      .withLevel(2, 'Class/Interface')
      .withCategory('structures', ['go-interfaces'])
      .withSource({ file: relativePath, line: intf.lineStart, end_line: intf.lineEnd })
      .withMetadata({
        language: 'go',
        is_exported: intf.isExported,
        attributes: {
          packageName: intf.packageName,
          methodCount: intf.methods.length,
          embedded: intf.embedded,
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
      nodes.push(this.createNodeBuilder(
        methodId,
        method.name,
        'interface_method'
      )
        .withLevel(4, 'Method/Function')
        .withCategory('methods', ['interface-methods'])
        .withSource({ file: relativePath, line: method.lineStart, end_line: method.lineEnd })
        .withMetadata({
          is_exported: method.isExported,
          attributes: {
            parameterCount: method.parameters.length,
            returnTypeCount: method.returnTypes.length,
            isInterface: true
          }
        })
        .withSignature({
          parameters: method.parameters,
          return_type: method.returnTypes.join(', ')
        })
        .withParent(interfaceId)
        .build());

      edges.push(this.createEdge(
        `${interfaceId}_declares_${methodId}`,
        interfaceId,
        methodId,
        'declares'
      ));
    }

    if (intf.isExported) {
      entryPoints.push({
        id: `entry_${interfaceId}`,
        name: `Exported interface: ${intf.name}`,
        type: 'exported_interface',
        source_node: interfaceId,
        metadata: {
          packageName: intf.packageName,
          interfaceName: intf.name,
          embedded: intf.embedded
        }
      });
    }
  }

  private async processGoFunction(
    func: GoFunction,
    fileId: string,
    fullPath: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const functionId = `function_${this.sanitizeId(func.packageName)}_${this.sanitizeId(func.name)}_${func.lineStart}`;
    const content = await fs.readFile(fullPath, 'utf-8');
    const lines = content.split('\n');
    const functionComments = this.extractCommentsFromFile(content, relativePath).filter(c =>
      c.location.line >= func.lineStart - 3 && c.location.line <= func.lineStart
    );
    const functionTodos = this.extractTodosFromComments(functionComments, functionId);
    const functionDocs = this.extractDocumentationFromGoDoc(lines, func.lineStart - 1);
    const functionBody = lines.slice(func.lineStart - 1, func.lineEnd);
    const implementationStatus = this.detectImplementationStatus(func, functionBody);

    nodes.push(this.createNodeBuilder(
      functionId,
      func.name,
      'function'
    )
      .withLevel(3, 'Function/Method')
      .withCategory('functions', func.receiver ? ['method-functions'] : ['standalone-functions'])
      .withSource({ file: relativePath, line: func.lineStart, end_line: func.lineEnd })
      .withMetadata({
        language: 'go',
        is_exported: func.isExported,
        attributes: {
          packageName: func.packageName,
          isMain: func.isMain,
          isInit: func.isInit,
          hasReceiver: !!func.receiver,
          receiver: func.receiver,
          parameterCount: func.parameters.length,
          returnTypeCount: func.returnTypes.length,
          hasDocumentation: !!functionDocs
        }
      })
      .withSignature({
        parameters: func.parameters,
        return_type: func.returnTypes.join(', ')
      })
      .withDocumentation(functionDocs)
      .withComments(functionComments.length > 0 ? functionComments : undefined)
      .withTodos(functionTodos.length > 0 ? functionTodos : undefined)
      .withImplementationStatus(implementationStatus)
      .build());

    edges.push(this.createEdge(
      `${fileId}_contains_${functionId}`,
      fileId,
      functionId,
      'contains'
    ));

    if (func.isMain) {
      entryPoints.push({
        id: `entry_${functionId}`,
        name: `Main function: ${func.name}`,
        type: 'main_function',
        source_node: functionId,
        metadata: {
          packageName: func.packageName,
          functionName: func.name
        }
      });
    } else if (func.isInit) {
      entryPoints.push({
        id: `entry_${functionId}`,
        name: `Init function: ${func.name}`,
        type: 'init_function',
        source_node: functionId,
        metadata: {
          packageName: func.packageName,
          functionName: func.name
        }
      });
    } else if (func.isExported) {
      entryPoints.push({
        id: `entry_${functionId}`,
        name: `Exported function: ${func.name}`,
        type: 'exported_function',
        source_node: functionId,
        metadata: {
          packageName: func.packageName,
          functionName: func.name,
          returnTypes: func.returnTypes,
          parameters: func.parameters.map(p => p.type)
        }
      });
    }
  }

  private async processGoType(
    type: GoType,
    fileId: string,
    fullPath: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const typeId = `type_${this.sanitizeId(type.packageName)}_${this.sanitizeId(type.name)}`;
    const content = await fs.readFile(fullPath, 'utf-8');
    const typeComments = this.extractCommentsFromFile(content, relativePath).filter(c =>
      c.location.line >= type.lineNumber - 3 && c.location.line <= type.lineNumber
    );
    const typeTodos = this.extractTodosFromComments(typeComments, typeId);
    const typeDocs = this.extractDocumentationFromGoDoc(
      content.split('\n'),
      type.lineNumber - 1
    );

    nodes.push(this.createNodeBuilder(
      typeId,
      type.name,
      'type'
    )
      .withLevel(2, 'Type/Interface')
      .withCategory('structures', ['go-types'])
      .withSource({ file: relativePath, line: type.lineNumber })
      .withMetadata({
        language: 'go',
        is_exported: type.isExported,
        attributes: {
          packageName: type.packageName,
          underlying: type.underlying,
          methodCount: type.methods.length,
          hasDocumentation: !!typeDocs
        }
      })
      .withDocumentation(typeDocs)
      .withComments(typeComments.length > 0 ? typeComments : undefined)
      .withTodos(typeTodos.length > 0 ? typeTodos : undefined)
      .build());

    edges.push(this.createEdge(
      `${fileId}_contains_${typeId}`,
      fileId,
      typeId,
      'contains'
    ));

    for (const method of type.methods) {
      const methodId = `method_${typeId}_${this.sanitizeId(method.name)}_${method.lineStart}`;
      const methodDocs = this.extractDocumentationFromGoDoc(
        content.split('\n'),
        method.lineStart - 1
      );
      const methodComments = this.extractCommentsFromFile(content, relativePath).filter(c =>
        c.location.line >= method.lineStart && c.location.line <= method.lineEnd
      );
      const methodTodos = this.extractTodosFromComments(methodComments, methodId);

      nodes.push(this.createNodeBuilder(
        methodId,
        method.name,
        'method'
      )
        .withLevel(4, 'Method/Function')
        .withCategory('methods', ['type-methods'])
        .withSource({ file: relativePath, line: method.lineStart, end_line: method.lineEnd })
        .withMetadata({
          is_exported: method.isExported,
          attributes: {
            receiver: method.receiver,
            parameterCount: method.parameters.length,
            returnTypeCount: method.returnTypes.length,
            hasDocumentation: !!methodDocs
          }
        })
        .withSignature({
          parameters: method.parameters,
          return_type: method.returnTypes.join(', ')
        })
        .withParent(typeId)
        .withDocumentation(methodDocs)
        .withComments(methodComments.length > 0 ? methodComments : undefined)
        .withTodos(methodTodos.length > 0 ? methodTodos : undefined)
        .build());

      edges.push(this.createEdge(
        `${typeId}_has_method_${methodId}`,
        typeId,
        methodId,
        'has_method'
      ));
    }

    if (type.isExported) {
      entryPoints.push({
        id: `entry_${typeId}`,
        name: `Exported type: ${type.name}`,
        type: 'exported_type',
        source_node: typeId,
        metadata: {
          packageName: type.packageName,
          typeName: type.name,
          underlying: type.underlying
        }
      });
    }
  }

  private extractPackage(content: string): string | null {
    const packageMatch = content.match(/^package\s+(\w+)/m);
    return packageMatch ? packageMatch[1] : null;
  }

  private extractImports(content: string): GoImport[] {
    const imports: GoImport[] = [];
    const lines = content.split('\n');
    let inImportBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line === 'import (') {
        inImportBlock = true;
        continue;
      }

      if (line === ')' && inImportBlock) {
        inImportBlock = false;
        continue;
      }

      const singleImportMatch = line.match(/^import\s+(?:(\w+|\.|_)\s+)?"([^"]+)"/);
      if (singleImportMatch) {
        const alias = singleImportMatch[1];
        const path = singleImportMatch[2];

        imports.push({
          path,
          alias: alias && alias !== '.' && alias !== '_' ? alias : undefined,
          lineNumber: i + 1,
          isStandard: this.isStandardPackage(path),
          isDotImport: alias === '.',
          isBlankImport: alias === '_'
        });
        continue;
      }

      if (inImportBlock && line) {
        const blockImportMatch = line.match(/^(?:(\w+|\.|_)\s+)?"([^"]+)"/);
        if (blockImportMatch) {
          const alias = blockImportMatch[1];
          const path = blockImportMatch[2];

          imports.push({
            path,
            alias: alias && alias !== '.' && alias !== '_' ? alias : undefined,
            lineNumber: i + 1,
            isStandard: this.isStandardPackage(path),
            isDotImport: alias === '.',
            isBlankImport: alias === '_'
          });
        }
      }
    }

    return imports;
  }

  private extractStructs(content: string, filePath: string): GoStruct[] {
    const structs: GoStruct[] = [];
    const lines = content.split('\n');
    const packageName = this.extractPackage(content) || 'main';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('type ') && line.includes('struct')) {
        const structMatch = line.match(/type\s+(\w+)\s+struct/);
        if (structMatch) {
          const structName = structMatch[1];
          const structStartLine = i + 1;
          const structEndLine = this.findBlockEnd(lines, i);

          const fields = this.extractStructFields(lines, i, structEndLine);
          const methods = this.extractMethodsForType(lines, structName, packageName);
          const tags = this.extractStructTags(lines, i, structEndLine);
          const embedded = this.extractEmbeddedTypes(lines, i, structEndLine);

          structs.push({
            name: structName,
            packageName,
            filePath,
            fields,
            methods,
            tags,
            embedded,
            lineStart: structStartLine,
            lineEnd: structEndLine,
            isExported: this.isExported(structName)
          });
        }
      }
    }

    return structs;
  }

  private extractInterfaces(content: string, filePath: string): GoInterface[] {
    const interfaces: GoInterface[] = [];
    const lines = content.split('\n');
    const packageName = this.extractPackage(content) || 'main';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('type ') && line.includes('interface')) {
        const interfaceMatch = line.match(/type\s+(\w+)\s+interface/);
        if (interfaceMatch) {
          const interfaceName = interfaceMatch[1];
          const interfaceStartLine = i + 1;
          const interfaceEndLine = this.findBlockEnd(lines, i);

          const methods = this.extractInterfaceMethods(lines, i, interfaceEndLine);
          const embedded = this.extractEmbeddedTypes(lines, i, interfaceEndLine);

          interfaces.push({
            name: interfaceName,
            packageName,
            filePath,
            methods,
            embedded,
            lineStart: interfaceStartLine,
            lineEnd: interfaceEndLine,
            isExported: this.isExported(interfaceName)
          });
        }
      }
    }

    return interfaces;
  }

  private extractFunctions(content: string, filePath: string): GoFunction[] {
    const functions: GoFunction[] = [];
    const lines = content.split('\n');
    const packageName = this.extractPackage(content) || 'main';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('func ')) {
        const funcMatch = line.match(/func(?:\s+\(([^)]+)\))?\s+(\w+)\s*\(([^)]*)\)(?:\s*\(([^)]*)\)|\s+([^{]+))?/);
        if (funcMatch) {
          const receiverStr = funcMatch[1];
          const functionName = funcMatch[2];
          const paramsStr = funcMatch[3];
          const returnTypesStr = funcMatch[4] || funcMatch[5];

          const functionStartLine = i + 1;
          const functionEndLine = this.findBlockEnd(lines, i);

          const parameters = this.extractFunctionParameters(paramsStr);
          const returnTypes = this.extractReturnTypes(returnTypesStr);
          const receiver = receiverStr ? this.parseReceiver(receiverStr) : undefined;

          functions.push({
            name: functionName,
            packageName,
            filePath,
            parameters,
            returnTypes,
            receiver,
            lineStart: functionStartLine,
            lineEnd: functionEndLine,
            isExported: this.isExported(functionName),
            isMain: functionName === 'main' && packageName === 'main',
            isInit: functionName === 'init'
          });
        }
      }
    }

    return functions;
  }

  private extractTypes(content: string, filePath: string): GoType[] {
    const types: GoType[] = [];
    const lines = content.split('\n');
    const packageName = this.extractPackage(content) || 'main';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('type ') && !line.includes('struct') && !line.includes('interface')) {
        const typeMatch = line.match(/type\s+(\w+)\s+(.+)/);
        if (typeMatch) {
          const typeName = typeMatch[1];
          const underlying = typeMatch[2];

          const methods = this.extractMethodsForType(lines, typeName, packageName);

          types.push({
            name: typeName,
            packageName,
            filePath,
            underlying,
            methods,
            lineNumber: i + 1,
            isExported: this.isExported(typeName)
          });
        }
      }
    }

    return types;
  }

  private extractVariables(content: string): GoVariable[] {
    const variables: GoVariable[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('var ')) {
        const varMatch = line.match(/var\s+(\w+)(?:\s+([^=]+))?(?:\s*=\s*(.+))?/);
        if (varMatch) {
          const varName = varMatch[1];
          const type = varMatch[2]?.trim();
          const value = varMatch[3]?.trim();

          variables.push({
            name: varName,
            type,
            value,
            lineNumber: i + 1,
            isExported: this.isExported(varName),
            isConst: false,
            scope: 'package'
          });
        }
      }
    }

    return variables;
  }

  private extractConstants(content: string): GoConstant[] {
    const constants: GoConstant[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('const ')) {
        const constMatch = line.match(/const\s+(\w+)(?:\s+([^=]+))?(?:\s*=\s*(.+))?/);
        if (constMatch) {
          const constName = constMatch[1];
          const type = constMatch[2]?.trim();
          const value = constMatch[3]?.trim();

          constants.push({
            name: constName,
            type,
            value,
            lineNumber: i + 1,
            isExported: this.isExported(constName),
            iota: value?.includes('iota')
          });
        }
      }
    }

    return constants;
  }

  private extractStructFields(lines: string[], structStart: number, structEnd: number): GoField[] {
    const fields: GoField[] = [];

    for (let i = structStart + 1; i < structEnd; i++) {
      const line = lines[i].trim();

      if (line && !line.startsWith('//') && !line.startsWith('{') && !line.startsWith('}')) {
        const fieldMatch = line.match(/^(\w+)\s+([^`]+)(?:`([^`]+)`)?/);
        if (fieldMatch) {
          const fieldName = fieldMatch[1];
          const fieldType = fieldMatch[2].trim();
          const tag = fieldMatch[3];

          fields.push({
            name: fieldName,
            type: fieldType,
            tag,
            lineNumber: i + 1,
            isExported: this.isExported(fieldName),
            isEmbedded: false
          });
        } else {
          const embeddedMatch = line.match(/^([A-Z]\w*)(?:`([^`]+)`)?/);
          if (embeddedMatch) {
            fields.push({
              name: embeddedMatch[1],
              type: embeddedMatch[1],
              tag: embeddedMatch[2],
              lineNumber: i + 1,
              isExported: true,
              isEmbedded: true
            });
          }
        }
      }
    }

    return fields;
  }

  private extractInterfaceMethods(lines: string[], interfaceStart: number, interfaceEnd: number): GoMethod[] {
    const methods: GoMethod[] = [];

    for (let i = interfaceStart + 1; i < interfaceEnd; i++) {
      const line = lines[i].trim();

      if (line && !line.startsWith('//') && !line.startsWith('{') && !line.startsWith('}')) {
        const methodMatch = line.match(/^(\w+)\s*\(([^)]*)\)(?:\s*\(([^)]*)\)|\s+([^{]+))?/);
        if (methodMatch) {
          const methodName = methodMatch[1];
          const paramsStr = methodMatch[2];
          const returnTypesStr = methodMatch[3] || methodMatch[4];

          const parameters = this.extractFunctionParameters(paramsStr);
          const returnTypes = this.extractReturnTypes(returnTypesStr);

          methods.push({
            name: methodName,
            parameters,
            returnTypes,
            lineStart: i + 1,
            lineEnd: i + 1,
            isExported: this.isExported(methodName)
          });
        }
      }
    }

    return methods;
  }

  private extractMethodsForType(lines: string[], typeName: string, packageName: string): GoMethod[] {
    const methods: GoMethod[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('func ')) {
        const methodMatch = line.match(/func\s+\(([^)]+)\)\s+(\w+)\s*\(([^)]*)\)(?:\s*\(([^)]*)\)|\s+([^{]+))?/);
        if (methodMatch) {
          const receiverStr = methodMatch[1];
          const methodName = methodMatch[2];

          if (receiverStr.includes(typeName)) {
            const paramsStr = methodMatch[3];
            const returnTypesStr = methodMatch[4] || methodMatch[5];

            const parameters = this.extractFunctionParameters(paramsStr);
            const returnTypes = this.extractReturnTypes(returnTypesStr);
            const receiver = this.parseReceiver(receiverStr);

            const methodEndLine = this.findBlockEnd(lines, i);

            methods.push({
              name: methodName,
              parameters,
              returnTypes,
              receiver,
              lineStart: i + 1,
              lineEnd: methodEndLine,
              isExported: this.isExported(methodName)
            });
          }
        }
      }
    }

    return methods;
  }

  private extractFunctionParameters(paramsStr: string): GoParameter[] {
    const parameters: GoParameter[] = [];

    if (!paramsStr || !paramsStr.trim()) {
      return parameters;
    }

    const params = this.splitFunctionParams(paramsStr);

    for (const param of params) {
      const trimmed = param.trim();

      if (trimmed.startsWith('...')) {
        const variadicMatch = trimmed.match(/^\.\.\.(\w+)\s+(.+)/);
        if (variadicMatch) {
          parameters.push({
            name: variadicMatch[1],
            type: variadicMatch[2],
            isVariadic: true
          });
        }
      } else {
        const paramMatch = trimmed.match(/^(\w+)\s+(.+)/);
        if (paramMatch) {
          parameters.push({
            name: paramMatch[1],
            type: paramMatch[2],
            isVariadic: false
          });
        } else if (trimmed) {
          parameters.push({
            name: '',
            type: trimmed,
            isVariadic: false
          });
        }
      }
    }

    return parameters;
  }

  private extractReturnTypes(returnTypesStr?: string): string[] {
    if (!returnTypesStr || !returnTypesStr.trim()) {
      return [];
    }

    const trimmed = returnTypesStr.trim();

    if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
      const inner = trimmed.slice(1, -1);
      return inner.split(',').map(t => t.trim()).filter(t => t);
    }

    return [trimmed];
  }

  private parseReceiver(receiverStr: string): GoReceiver {
    const receiverMatch = receiverStr.match(/^(\w+)\s+(\*?)(\w+)/);
    if (receiverMatch) {
      return {
        name: receiverMatch[1],
        type: receiverMatch[3],
        isPointer: receiverMatch[2] === '*'
      };
    }

    return {
      name: '',
      type: receiverStr.trim(),
      isPointer: false
    };
  }

  private extractStructTags(lines: string[], structStart: number, structEnd: number): string[] {
    const tags: string[] = [];

    for (let i = structStart + 1; i < structEnd; i++) {
      const line = lines[i].trim();
      const tagMatch = line.match(/`([^`]+)`/);
      if (tagMatch) {
        tags.push(tagMatch[1]);
      }
    }

    return tags;
  }

  private extractEmbeddedTypes(lines: string[], blockStart: number, blockEnd: number): string[] {
    const embedded: string[] = [];

    for (let i = blockStart + 1; i < blockEnd; i++) {
      const line = lines[i].trim();
      const embeddedMatch = line.match(/^([A-Z]\w*)\s*$/);
      if (embeddedMatch) {
        embedded.push(embeddedMatch[1]);
      }
    }

    return embedded;
  }

  private splitFunctionParams(paramsStr: string): string[] {
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

  private buildPackageHierarchy(packages: Map<string, string[]>, nodes: CASNode[], edges: CASEdge[]): void {
    for (const [packageName, files] of packages.entries()) {
      const packageId = `package_${this.sanitizeId(packageName)}`;

      nodes.push(this.createNodeBuilder(
        packageId,
        packageName,
        'package'
      )
        .withLevel(1, 'Package/Module')
        .withCategory('modules', ['go-packages'])
        .withMetadata({
          attributes: {
            fileCount: files.length,
            files: files,
            packageType: packageName === 'main' ? 'executable' : 'library'
          }
        })
        .build());

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

  /**
   * Extract HTTP routes from the common Go web frameworks. Gin/Echo/Fiber expose a
   * `router.METHOD("/path", handler)` builder; Gorilla mux uses
   * `router.HandleFunc("/path", h).Methods("GET", ...)`. Both name the verb + path
   * explicitly — the route fact embeddings/structural indexers can't produce.
   */
  /**
   * Blank out Go `//` line and `/* *​/` block comments, preserving string/rune
   * literals (so a route path containing "//" or a `*` stays intact) and
   * newline positions (so line-based reasoning elsewhere is unaffected).
   */
  private stripGoComments(src: string): string {
    let out = '';
    let i = 0;
    const n = src.length;
    let quote: string | null = null;
    while (i < n) {
      const c = src[i];
      if (quote) {
        out += c;
        if (c === '\\' && quote !== '`' && i + 1 < n) {
          out += src[i + 1];
          i += 2;
          continue;
        }
        if (c === quote) quote = null;
        i++;
        continue;
      }
      if (c === '"' || c === '`' || c === "'") {
        quote = c;
        out += c;
        i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '/') {
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
          out += src[i] === '\n' ? '\n' : ' ';
          i++;
        }
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  private extractGoHttpRoutes(content: string, fileId: string, relativePath: string, entryPoints: any[]): void {
    // Gate on a web-framework signal so an arbitrary `cfg.GET("key")` call in
    // non-routing code can't masquerade as a route.
    if (!/gin-gonic\/gin|labstack\/echo|gofiber\/fiber|gorilla\/mux|net\/http|chi\b|\bRouter\b/.test(content)) return;
    // Strip comments before matching so a commented-out route registration
    // (`// mux.HandleFunc("GET /debug", h)`) can't masquerade as a live route.
    content = this.stripGoComments(content);
    const seen = new Set<string>();
    const push = (method: string, rawPath: string, authed = false) => {
      const m = method.toUpperCase();
      // Gorilla `{id}` / `{id:[0-9]+}` and Gin `:id` both canonicalize to `:id`.
      const path = rawPath
        .replace(/\{(\w+)(?:\.\.\.|:[^}]*)?\}/g, ':$1')
        .replace(/\/+$/,'') || '/';
      const key = `${m} ${path}`;
      if (seen.has(key)) return;
      seen.add(key);
      entryPoints.push({
        id: `entry_go_route_${this.sanitizeId(relativePath)}_${m}_${this.sanitizeId(path)}`,
        source_node: fileId,
        type: 'http',
        name: `${m} ${path}`,
        trigger: { method: m, path },
        security: { authenticated: authed },
        metadata: { framework: 'go', kind: 'route', file: relativePath, language: 'go' },
      });
    };

    // Router groups: `v1 := r.Group("/api/v1")` (Gin) / `e.Group("/api")` (Echo)
    // mount routes under a prefix. Resolve each group var's full prefix
    // (transitively for nested groups) so a `v1.GET("/users")` is "/api/v1/users".
    const groupParent = new Map<string, { parent: string; local: string }>();
    for (const g of content.matchAll(/\b(\w+)\s*:=\s*(\w+)\.Group\s*\(\s*"([^"]*)"/g)) {
      groupParent.set(g[1], { parent: g[2], local: g[3] });
    }
    // Gorilla subrouters: `api := r.PathPrefix("/api").Subrouter()` mount routes
    // under a prefix, same prefix-resolution shape as Gin groups.
    for (const g of content.matchAll(/\b(\w+)\s*:=\s*(\w+)\.PathPrefix\s*\(\s*"([^"]*)"\s*\)\s*\.Subrouter\s*\(\s*\)/g)) {
      groupParent.set(g[1], { parent: g[2], local: g[3] });
    }
    const resolvePrefix = (v: string): string => {
      const parts: string[] = [];
      const seen = new Set<string>();
      let cur = v;
      while (groupParent.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        const g = groupParent.get(cur)!;
        parts.unshift(g.local);
        cur = g.parent;
      }
      return parts.join('');
    };

    // Group-wide auth: `admin.Use(AuthRequired())` protects every route registered
    // on that group (and its nested children). Track which group vars carry auth.
    const groupAuthed = new Set<string>();
    for (const u of content.matchAll(/\b(\w+)\.Use\s*\(([^)]*(?:\([^)]*\))?[^)]*)\)/g)) {
      if ([...u[2].matchAll(/\b([A-Za-z_]\w*)\b/g)].some(id => isAuthenticationGuardName(id[1]))) {
        groupAuthed.add(u[1]);
      }
    }
    const inheritsAuth = (v: string): boolean => {
      const seen = new Set<string>();
      let cur = v;
      while (cur && !seen.has(cur)) {
        if (groupAuthed.has(cur)) return true;
        seen.add(cur);
        cur = groupParent.get(cur)?.parent || '';
      }
      return false;
    };

    // Gin/Echo all-caps `r.GET(...)`, Fiber PascalCase `app.Get(...)`. Capture
    // receiver (group prefix) + the arg tail (per-route auth mw).
    const builderRe = /\b(\w+)\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Get|Post|Put|Delete|Patch|Head|Options)\s*\(\s*"([^"]+)"\s*((?:,[^)]*)?)\)/g;
    let m: RegExpExecArray | null;
    while ((m = builderRe.exec(content)) !== null) {
      const recv = m[1];
      const argsTail = m[4] || '';
      const authed = inheritsAuth(recv) || [...argsTail.matchAll(/\b([A-Za-z_]\w*)\b/g)]
        .some(id => isAuthenticationGuardName(id[1]));
      push(m[2], resolvePrefix(recv) + m[3], authed);
    }

    // Gorilla mux: `r.HandleFunc("/users", h).Methods("GET", "POST")`. Capture the
    // receiver so a subrouter's PathPrefix is prepended. Verbs may be quoted
    // string literals or `net/http` constants (`http.MethodGet`) — idiomatic
    // modern Go favors the constant form, so both must resolve to the same verb.
    const httpMethodConst: Record<string, string> = {
      MethodGet: 'GET', MethodPost: 'POST', MethodPut: 'PUT', MethodDelete: 'DELETE',
      MethodPatch: 'PATCH', MethodHead: 'HEAD', MethodOptions: 'OPTIONS',
      MethodConnect: 'CONNECT', MethodTrace: 'TRACE',
    };
    const gorillaRe = /\b(\w+)\.HandleFunc\s*\(\s*"([^"]+)"[^)]*\)\s*\.Methods\s*\(([^)]*)\)/g;
    while ((m = gorillaRe.exec(content)) !== null) {
      const path = resolvePrefix(m[1]) + m[2];
      const authed = inheritsAuth(m[1]);
      for (const verb of m[3].matchAll(/"([A-Za-z]+)"|\bhttp\.(Method\w+)/g)) {
        const v = verb[1] || httpMethodConst[verb[2]];
        if (v) push(v, path, authed);
      }
    }

    // Whole-handler auth wrap: `return authMw.handle(otherMw.handle(mux))` (or
    // `return middleware.validateAPIKeyAuth(mux)`) protects every route
    // registered on that mux var — the net/http-stdlib equivalent of a Gin/Echo
    // group's `.Use()`. Match the `return`-statement's innermost bare
    // identifier as the wrapped var, and check the wrapper call names (which
    // may be dotted, e.g. `middleware.validateAPIKeyAuth`) for an auth verb.
    const wholeHandlerAuthed = new Set<string>();
    for (const ret of content.matchAll(/\breturn\s+([^\n;]+?);?\s*(?:\n|$)/g)) {
      const expr = ret[1];
      const innermost = expr.match(/\(\s*(\w+)\s*\)\)*\s*$/);
      if (!innermost) continue;
      const wrapperCalls = [...expr.matchAll(/([A-Za-z_][\w.]*)\s*\(/g)].map(w => w[1]);
      if (wrapperCalls.some(name => isAuthenticationGuardName(name))) {
        wholeHandlerAuthed.add(innermost[1]);
      }
    }

    // Go 1.22+ stdlib `http.ServeMux` enhanced routing patterns:
    // `mux.HandleFunc("GET /v1/entries/{entryID}", handler.getEntriesHandler)`.
    // The verb lives inside the pattern string itself — neither the Gin/Echo
    // builder shape (verb as a separate method call) nor the Gorilla
    // `.Methods()` chain above can see this. Handler can be a struct-method
    // value (`handler.getX`) or an inline func literal; neither affects the
    // match since only the pattern string is captured.
    const stdlibPatternRe = /\b(\w+)\.HandleFunc\s*\(\s*"(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+([^"\s]+)"/g;
    while ((m = stdlibPatternRe.exec(content)) !== null) {
      const recv = m[1];
      const path = resolvePrefix(recv) + m[3];
      const authed = inheritsAuth(recv) || wholeHandlerAuthed.has(recv);
      push(m[2], path, authed);
    }
  }

  private detectFrameworkPatterns(nodes: CASNode[], _edges: CASEdge[], entryPoints: any[]): void {
    const frameworkPatterns = {
      gin: ['gin.Engine', 'gin.Context', 'gin.HandlerFunc'],
      echo: ['echo.Echo', 'echo.Context', 'echo.HandlerFunc'],
      gorilla: ['mux.Router', 'mux.Vars'],
      fiber: ['fiber.App', 'fiber.Ctx']
    };

    for (const node of nodes) {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'function' && node.metadata?.attributes?.parameters) {
        const parameters = node.metadata.attributes.parameters as GoParameter[];

        for (const [framework, patterns] of Object.entries(frameworkPatterns)) {
          if (patterns.some(pattern => parameters.some(p => p.type.includes(pattern)))) {
            entryPoints.push({
              id: `entry_${framework}_${node.id}`,
              name: `${framework.charAt(0).toUpperCase() + framework.slice(1)} handler: ${node.name}`,
              type: `${framework}_handler`,
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

  private buildTypeRelationships(nodes: CASNode[], edges: CASEdge[]): void {
    const structNodes = nodes.filter(n => n.type === 'struct');
    const interfaceNodes = nodes.filter(n => n.type === 'interface');

    for (const structNode of structNodes) {
      const structMethods = nodes.filter(n =>
        n.type === 'method' &&
        n.metadata?.attributes?.receiver &&
        (n.metadata.attributes.receiver as GoReceiver).type === structNode.name
      );

      for (const interfaceNode of interfaceNodes) {
        const interfaceMethods = nodes.filter(n =>
          n.type === 'interface_method' &&
          edges.some(e => e.source === interfaceNode.id && e.target === n.id)
        );

        const implementsInterface = interfaceMethods.every(intfMethod =>
          structMethods.some(structMethod => structMethod.name === intfMethod.name)
        );

        if (implementsInterface && interfaceMethods.length > 0) {
          edges.push(this.createEdge(
            `${structNode.id}_implements_${interfaceNode.id}`,
            structNode.id,
            interfaceNode.id,
            'implements'
          ));
        }
      }
    }
  }

  /**
   * Tags every node in a `_test.go` file (Go's own, universal test-file
   * naming convention — never a keyword/brand check) with `metadata.is_test`,
   * `category: 'test'`, and a `test-code` tag, mirroring the TS/JS analyzer's
   * applyTestSourceBoundary. Without this, Go test functions carried NO
   * test-owned marker of any kind, so the cross-language test-framework
   * analyzer's coverage-graph walk (test-framework-analyzer.ts's
   * isTestOwnedNode / graphNodesForSuite) could never start a traversal from
   * this analyzer's OWN function nodes — only from its own synthetic
   * suite/case nodes, which carry no `calls` edges of their own. Real hosted
   * effect: every Go project's journeys/capabilities reported
   * `tests_present: false` and `tests_covering: []` even when `go test`
   * itself passed hundreds of tests (test_summary counts test FILES/CASES
   * discovered independently of this graph link) — a self-contradiction
   * between `test_summary.total_tests` and every per-capability/journey test
   * signal in the same response.
   */
  private applyTestFileBoundary(nodes: CASNode[]): void {
    for (const node of nodes) {
      const file = node.source?.file;
      if (!file || !/_test\.go$/i.test(file)) continue;
      node.metadata = { ...node.metadata, is_test: true };
      node.category = 'test';
      node.subcategories = [...new Set([...(node.subcategories || []), node.type, 'test-code'])];
      node.tags = [...new Set([...(node.tags || []), 'test-code'])];
    }
  }

  private isStandardPackage(path: string): boolean {
    const standardPackages = [
      'fmt', 'os', 'io', 'net', 'http', 'time', 'strings', 'strconv',
      'encoding', 'json', 'xml', 'crypto', 'reflect', 'sort', 'sync',
      'context', 'log', 'flag', 'path', 'regexp', 'bytes', 'bufio',
      'archive', 'compress', 'database', 'debug', 'go', 'hash',
      'html', 'image', 'index', 'math', 'mime', 'plugin', 'runtime',
      'testing', 'text', 'unicode', 'unsafe'
    ];

    const firstPart = path.split('/')[0];
    return standardPackages.includes(firstPart) || !path.includes('.');
  }

  private isExported(name: string): boolean {
    return name.length > 0 && name[0] >= 'A' && name[0] <= 'Z';
  }

  private async analyzeCallGraph(projectPath: string, nodes: CASNode[], edges: CASEdge[], exitPoints: CASExitPoint[]): Promise<void> {
    const goFiles = await glob(['**/*.go'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true
    });
    goFiles.sort();

    const functionNodes = nodes.filter(n => n.type === 'function' || n.type === 'method');
    const structNodes = nodes.filter(n => n.type === 'struct' || n.type === 'interface');

    for (const file of goFiles) {
      const fullPath = path.join(projectPath, file);

      try {
        const ast = await this.astRunner.parseGoAST(fullPath);
        if (ast) {
          this.astCache.set(file, ast);
          await this.processGoASTCallGraph(ast, fullPath, file, nodes, edges, exitPoints, functionNodes, structNodes);
          continue;
        }
      } catch (error) {
        console.debug('AST parsing failed, using enhanced fallback for', file);
      }

      await this.analyzeCallGraphEnhanced(fullPath, file, nodes, edges, exitPoints, functionNodes, structNodes, projectPath);
    }
  }

  private async processGoASTCallGraph(
    ast: GoASTNode,
    fullPath: string,
    file: string,
    nodes: CASNode[],
    edges: CASEdge[],
    exitPoints: CASExitPoint[],
    functionNodes: CASNode[],
    structNodes: CASNode[]
  ): Promise<void> {
    const currentPackage = ast.package || 'main';
    let fileContent = '';
    try { fileContent = fs.readFileSync(fullPath, 'utf-8'); } catch { /* best effort */ }

    for (const child of ast.children || []) {
      if (child.type === 'Function' && child.calls) {
        const callerFunction = functionNodes.find(n =>
          n.name === child.name &&
          n.source?.file === file
        );

        if (!callerFunction) continue;

        // Receiver var -> declared type, so `l.Save()` (l: *Logger) resolves to
        // Logger.Save, not whichever Save method happens to be first. Built from
        // the caller's signature (receiver + params) and simple local decls.
        const recvTypes = this.buildGoReceiverTypeMap(
          fileContent, callerFunction.source?.line, callerFunction.source?.end_line
        );

        for (const call of child.calls) {
          let targetFunction: CASNode | undefined;

          if (call.package) {
            const stripPtr = (s: string) => String(s || '').replace(/^[\*&]+/, '');
            const recvType = stripPtr(recvTypes.get(call.package) || call.package);

            // 1) Type-aware: a method named `function` whose receiver IS this type.
            targetFunction = functionNodes.find(n =>
              n.type === 'method' && n.name === call.function &&
              stripPtr(n.metadata?.attributes?.receiver?.type as string) === recvType
            );

            // 2) Struct named by the resolved type -> its method.
            if (!targetFunction) {
              const targetStruct = structNodes.find(s => s.name === recvType);
              if (targetStruct) {
                targetFunction = functionNodes.find(n =>
                  n.name === call.function &&
                  edges.some(e => e.source === targetStruct.id && e.target === n.id && e.type === 'has_method')
                );
              }
            }

            // 3) Unambiguous fallback: exactly ONE method has this name -> use it
            //    (preserves recall where the receiver type couldn't be resolved;
            //    when ambiguous and unresolved, we do NOT guess — no false edge).
            if (!targetFunction) {
              const named = functionNodes.filter(n => n.type === 'method' && n.name === call.function);
              if (named.length === 1) targetFunction = named[0];
            }
          } else {
            targetFunction = functionNodes.find(n =>
              n.name === call.function &&
              n.type === 'function'
            );
          }

          if (targetFunction && targetFunction.id !== callerFunction.id) {
            const callEdgeId = `call_${callerFunction.id}_to_${targetFunction.id}_line_${call.line}`;
            if (!edges.some(e => e.id === callEdgeId)) {
              edges.push(this.createEdge(
                callEdgeId,
                callerFunction.id,
                targetFunction.id,
                'calls',
                'behavior',
                {
                  line: call.line,
                  column: call.column,
                  callType: call.package ? 'method' : 'function',
                  targetPackage: call.package,
                  targetFunction: call.function
                }
              ));
            }
          } else if (this.isExternalLibraryCall(call.package || call.function, call.package ? call.function : undefined, currentPackage)) {
            const exitId = `exit_call_${callerFunction.id}_${call.package || ''}_${call.function}_${call.line}`;
            if (!exitPoints.some(e => e.id === exitId)) {
              exitPoints.push(this.createExitPoint(
                exitId,
                callerFunction.id,
                'sdk',
                call.package ? `External call: ${call.package}.${call.function}` : `External call: ${call.function}`,
                `Library call to ${this.identifyGoLibrary(call.package || call.function)}`,
                undefined,
                undefined,
                {
                  targetPackage: call.package || call.function,
                  targetFunction: call.function,
                  line: call.line,
                  column: call.column,
                  library: this.identifyGoLibrary(call.package || call.function)
                }
              ));
            }
          }
        }
      }
    }
  }

  private async analyzeCallGraphEnhanced(
    fullPath: string,
    file: string,
    nodes: CASNode[],
    edges: CASEdge[],
    exitPoints: CASExitPoint[],
    functionNodes: CASNode[],
    structNodes: CASNode[],
    projectPath: string
  ): Promise<void> {
    const content = await fs.readFile(fullPath, 'utf-8');
    const lines = content.split('\n');
    const currentPackage = this.extractPackage(content) || 'main';

    let currentFunction: CASNode | undefined;
    let currentScope: { start: number; end: number; node: CASNode } | undefined;
    const scopeStack: { start: number; end: number; node: CASNode }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      if (line.includes('func ')) {
        const funcMatch = line.match(/func(?:\s+\(([^)]+)\))?\s+(\w+)\s*\(/);
        if (funcMatch) {
          const funcName = funcMatch[2];
          currentFunction = functionNodes.find(n =>
            n.name === funcName &&
            n.source?.file === file &&
            n.source?.line !== undefined && Math.abs(n.source.line - lineNum) <= 2
          );
          if (currentFunction) {
            currentScope = {
              start: lineNum,
              end: currentFunction.source?.end_line || lineNum + 100,
              node: currentFunction
            };
          }
        }
      }

      if (currentScope && lineNum > currentScope.end) {
        currentScope = scopeStack.pop();
        if (!currentScope) {
          currentFunction = undefined;
        }
      }

      if (!currentFunction) {
        currentFunction = functionNodes.find(n =>
          n.source?.file === file &&
          n.source?.line !== undefined && n.source.line <= lineNum &&
          n.source?.end_line !== undefined && n.source.end_line >= lineNum
        );
      }

      if (currentFunction) {
        const functionCalls = this.extractGoCallsFromLine(line, structNodes);

        for (const call of functionCalls) {
          const { target, method, isGoroutine, isDefer, isChannel } = call;

          let targetFunction: CASNode | undefined;

          if (method) {
            targetFunction = functionNodes.find(n => {
              if (n.type !== 'method' || n.name !== method) return false;

              const methodReceiver = n.metadata?.attributes?.receiver as GoReceiver;
              if (!methodReceiver) return false;

              const receiverType = methodReceiver.type;
              const normalizedTarget = target.replace(/^\*/, '').replace(/^&/, '');

              return receiverType === normalizedTarget ||
                     receiverType === target ||
                     (target === 'this' && edges.some(e =>
                       e.type === 'has_method' && e.target === n.id &&
                       nodes.find(s => s.id === e.source)?.source?.file === file
                     ));
            });

            if (!targetFunction && target !== 'this') {
              const targetStruct = structNodes.find(s =>
                s.name === target.replace(/^\*/, '').replace(/^&/, '')
              );
              if (targetStruct) {
                targetFunction = functionNodes.find(n =>
                  n.name === method &&
                  edges.some(e => e.source === targetStruct.id && e.target === n.id && e.type === 'has_method')
                );
              }
            }
          } else {
            targetFunction = functionNodes.find(n =>
              n.name === target &&
              n.type === 'function' &&
              (n.metadata?.attributes?.packageName === currentPackage ||
               n.metadata?.attributes?.packageName === undefined)
            );
          }

          if (targetFunction && targetFunction.id !== currentFunction.id) {
            const callEdgeId = `call_${currentFunction.id}_to_${targetFunction.id}_line_${lineNum}`;
            if (!edges.some(e => e.id === callEdgeId)) {
              edges.push(this.createEdge(
                callEdgeId,
                currentFunction.id,
                targetFunction.id,
                'calls',
                'behavior',
                {
                  line: lineNum,
                  callType: method ? 'method' : 'function',
                  isGoroutine,
                  isDefer,
                  isChannel,
                  targetObject: method ? target : undefined,
                  targetMethod: method || target
                }
              ));
            }
          } else if (this.isExternalLibraryCall(target, method, currentPackage)) {
            const exitId = `exit_call_${currentFunction.id}_${target}_${method || 'func'}_${lineNum}`;
            if (!exitPoints.some(e => e.id === exitId)) {
              exitPoints.push(this.createExitPoint(
                exitId,
                currentFunction.id,
                'sdk',
                method ? `External call: ${target}.${method}` : `External call: ${target}`,
                `Library call to ${this.identifyGoLibrary(target)}`,
                undefined,
                undefined,
                {
                  targetPackage: target,
                  targetFunction: method || target,
                  line: lineNum,
                  library: this.identifyGoLibrary(target),
                  isGoroutine,
                  isDefer
                }
              ));
            }
          }
        }
      }
    }
  }

  /** Map a Go function's local variable names to their bare struct types, from
   *  the caller's signature (receiver + params) and simple local declarations
   *  (`x := Foo{}`, `x := &Foo{}`, `var x Foo`). Used to resolve a method-call
   *  receiver (`l` in `l.Save()`) to the right type so same-name methods on
   *  different structs don't collide. */
  private buildGoReceiverTypeMap(content: string, startLine?: number, endLine?: number): Map<string, string> {
    const map = new Map<string, string>();
    if (!content || !startLine) return map;
    const lines = content.split('\n');
    const text = lines.slice(startLine - 1, (endLine && endLine >= startLine) ? endLine : startLine).join('\n');
    const bare = (t: string) => t.replace(/^[\*&\[\]]+/, '').replace(/\[\]/g, '').split('.').pop() || t;
    const header = text.split('{')[0];
    for (const m of header.matchAll(/\(([^()]*)\)/g)) {
      for (const p of this.extractFunctionParameters(m[1])) {
        if (p.name && p.type) map.set(p.name, bare(p.type));
      }
    }
    for (const m of text.matchAll(/\b([A-Za-z_]\w*)\s*:=\s*&?([A-Za-z_][\w.]*)\s*\{/g)) map.set(m[1], bare(m[2]));
    for (const m of text.matchAll(/\bvar\s+([A-Za-z_]\w*)\s+\*?([A-Za-z_][\w.]*)/g)) map.set(m[1], bare(m[2]));
    return map;
  }

  private extractGoCallsFromLine(line: string, structNodes: CASNode[]): Array<{target: string, method?: string, isGoroutine: boolean, isDefer: boolean, isChannel: boolean}> {
    const calls: Array<{target: string, method?: string, isGoroutine: boolean, isDefer: boolean, isChannel: boolean}> = [];

    const patterns = [
      /(?:go\s+)?(?:defer\s+)?([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)*)\s*\(/g,
      /(?:go\s+)?(?:defer\s+)?([a-zA-Z_][\w]*)\s*\.\s*([a-zA-Z_][\w]*)\s*\(/g,
      /<-\s*([a-zA-Z_][\w]*)(?:\.([a-zA-Z_][\w]*))?\s*\(/g,
      /([a-zA-Z_][\w]*)\s*<-/g,
      /make\s*\(\s*chan\s+/g,
      /\bnew\s*\(\s*([a-zA-Z_][\w]*)\s*\)/g
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(line)) !== null) {
        const fullMatch = match[0];
        const isGoroutine = fullMatch.includes('go ');
        const isDefer = fullMatch.includes('defer ');
        const isChannel = fullMatch.includes('<-') || fullMatch.includes('chan');

        if (match[2]) {
          calls.push({
            target: match[1],
            method: match[2],
            isGoroutine,
            isDefer,
            isChannel
          });
        } else if (match[1] && !['if', 'for', 'switch', 'select', 'case', 'return', 'func', 'type', 'var', 'const', 'import', 'package'].includes(match[1])) {
          calls.push({
            target: match[1],
            isGoroutine,
            isDefer,
            isChannel
          });
        }
      }
    }

    const typeAssertions = line.matchAll(/\.\((\*?[a-zA-Z_][\w]*)\)/g);
    for (const match of typeAssertions) {
      const typeName = match[1].replace(/^\*/, '');
      if (typeName && structNodes.find(s => s.name === typeName)) {
        calls.push({
          target: typeName,
          method: 'type_assertion',
          isGoroutine: false,
          isDefer: false,
          isChannel: false
        });
      }
    }

    const interfaceCalls = line.matchAll(/([a-zA-Z_][\w]*)\s*\.\s*\(\s*([a-zA-Z_][\w]*)\s*\)/g);
    for (const match of interfaceCalls) {
      calls.push({
        target: match[1],
        method: match[2],
        isGoroutine: false,
        isDefer: false,
        isChannel: false
      });
    }

    return calls;
  }

  private findHandlerFunction(lines: string[], startIndex: number): string | null {
    const line = lines[startIndex];
    const handlerMatch = line.match(/,\s*(\w+)\s*[,)]/);
    if (handlerMatch) {
      return handlerMatch[1];
    }
    return null;
  }

  private isExternalLibraryCall(packageOrFunc: string, methodName: string | undefined, currentPackage: string): boolean {
    const standardPackages = [
      'fmt', 'log', 'os', 'io', 'strings', 'strconv', 'time', 'math',
      'net', 'http', 'json', 'encoding', 'crypto', 'bytes', 'bufio',
      'context', 'sync', 'errors', 'reflect', 'runtime', 'sort'
    ];

    const frameworkPackages = [
      'gin', 'echo', 'mux', 'fiber', 'chi', 'martini',
      'gorm', 'sqlx', 'mongo', 'redis', 'grpc', 'protobuf'
    ];

    return standardPackages.includes(packageOrFunc) ||
           frameworkPackages.includes(packageOrFunc) ||
           (packageOrFunc.includes('/') && !packageOrFunc.startsWith(currentPackage)) ||
           (packageOrFunc.includes('.') && packageOrFunc !== currentPackage);
  }

  private identifyGoLibrary(packageName: string): string {
    const standardLibraries: Record<string, string> = {
      'fmt': 'Go Standard Library - Formatting',
      'log': 'Go Standard Library - Logging',
      'os': 'Go Standard Library - OS Interface',
      'io': 'Go Standard Library - I/O',
      'net': 'Go Standard Library - Networking',
      'http': 'Go Standard Library - HTTP',
      'json': 'Go Standard Library - JSON',
      'time': 'Go Standard Library - Time',
      'sync': 'Go Standard Library - Synchronization',
      'context': 'Go Standard Library - Context',
      'gin': 'Gin Web Framework',
      'echo': 'Echo Web Framework',
      'mux': 'Gorilla Mux Router',
      'fiber': 'Fiber Web Framework',
      'gorm': 'GORM ORM',
      'sqlx': 'sqlx Database Library',
      'redis': 'Redis Client',
      'grpc': 'gRPC Framework'
    };

    if (standardLibraries[packageName]) {
      return standardLibraries[packageName];
    }

    if (packageName.startsWith('github.com/')) {
      return `GitHub Package: ${packageName}`;
    }

    if (packageName.startsWith('golang.org/')) {
      return `Go Official Package: ${packageName}`;
    }

    return 'External Package';
  }

  private extractDocumentationFromGoDoc(lines: string[], lineIndex: number): CASDocumentation | undefined {
    let hasContent = false;
    let description = '';

    for (let i = lineIndex - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith('//')) break;

      const commentText = line.replace(/^\/\/\s*/, '');
      if (commentText) {
        description = commentText + (description ? '\n' + description : '');
        hasContent = true;
      }
    }

    if (hasContent) {
      const docs: CASDocumentation = {
        type: 'godoc',
        raw: description,
        location: { start_line: lineIndex - description.split('\n').length, end_line: lineIndex }
      };

      docs.summary = description.split('.')[0] + (description.includes('.') ? '.' : '');
      docs.description = description;

      const exampleMatch = description.match(/Example[:\s]+(.*?)(?=\n|$)/i);
      if (exampleMatch) {
        docs.examples = [{ code: exampleMatch[1], language: 'go' }];
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

      const singleLineMatch = line.match(/\/\/(.*)$/);
      if (singleLineMatch) {
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

  private detectImplementationStatus(functionInfo: GoFunction, functionBody: string[]): CASImplementationStatus {
    const bodyText = functionBody.join('\n').toLowerCase();

    const indicators = {
      has_todo_markers: bodyText.includes('todo') || bodyText.includes('fixme'),
      has_not_implemented_exceptions: bodyText.includes('panic("not implemented")') ||
                                      bodyText.includes('panic("todo")') ||
                                      bodyText.includes('log.fatal("not implemented")'),
      has_stub_returns: functionBody.length <= 2 && bodyText.includes('return'),
      has_placeholder_code: bodyText.includes('fmt.println("todo")'),
      has_hardcoded_values: false,
      has_commented_out_code: false
    };

    let status: CASImplementationStatus['status'] = 'complete';
    if (indicators.has_not_implemented_exceptions) {
      status = 'not-implemented';
    } else if (indicators.has_stub_returns) {
      status = 'stub';
    } else if (indicators.has_todo_markers || indicators.has_placeholder_code) {
      status = 'partial';
    } else if (bodyText.includes('// deprecated')) {
      status = 'deprecated';
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
      'struct-analysis',
      'interface-detection',
      'function-mapping',
      'package-organization',
      'method-receiver-analysis',
      'framework-detection',
      'go-modules-support'
    ];
  }
}
