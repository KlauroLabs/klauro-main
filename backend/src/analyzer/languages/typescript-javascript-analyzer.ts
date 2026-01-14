import { BaseAnalyzer, AnalysisContext } from '../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  CASCategories, CASPerspective, CASDocumentation, CASComment,
  CASTodo, CASImplementationStatus, CASCallGraph
} from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import { EnhancedCallGraphExtractor, ExtractedFunction } from '../enhanced-call-graph-extractor';
import * as path from 'path';
import * as fs from 'fs-extra';
import { parse, TSESTree } from '@typescript-eslint/typescript-estree';
import { glob } from 'glob';
import * as crypto from 'crypto';

interface ParsedAST {
  ast: TSESTree.Program;
  content: string;
  filePath: string;
}

interface FunctionInfo {
  name: string;
  type: 'function' | 'method' | 'arrow' | 'async' | 'constructor';
  parameters: Array<{ name: string; type?: string; optional: boolean; description?: string }>;
  returnType?: string;
  lineStart: number;
  lineEnd: number;
  isExported: boolean;
  isAsync: boolean;
  isGenerator?: boolean;
  documentation?: CASDocumentation;
  comments?: CASComment[];
  todos?: CASTodo[];
  implementationStatus?: CASImplementationStatus;
  callGraph?: CASCallGraph;
  decorators?: Array<{ name: string; arguments?: any[] }>;
}

interface ClassInfo {
  name: string;
  extends?: string;
  implements: string[];
  methods: FunctionInfo[];
  properties: Array<{
    name: string;
    type?: string;
    isStatic: boolean;
    isPrivate: boolean;
    documentation?: CASDocumentation;
    decorators?: Array<{ name: string; arguments?: any[] }>;
    lineStart: number;
    lineEnd: number;
  }>;
  lineStart: number;
  lineEnd: number;
  isExported: boolean;
  isAbstract: boolean;
  documentation?: CASDocumentation;
  decorators?: Array<{ name: string; arguments?: any[] }>;
  comments?: CASComment[];
}

interface ImportInfo {
  source: string;
  specifiers: Array<{ name: string; imported?: string }>;
  line: number;
}

interface VariableInfo {
  name: string;
  type?: string;
  value?: any;
  kind: 'const' | 'let' | 'var';
  line: number;
  isExported: boolean;
}

export class TypeScriptJavaScriptAnalyzer extends BaseAnalyzer {
  private astCache = new Map<string, ParsedAST>();
  private isTypeScriptProject = false;
  private callGraphExtractor!: EnhancedCallGraphExtractor;
  private todoCounter = 0;
  private commentCounter = 0;
  private importSourceMap = new Map<string, string>();
  private classFieldTypes = new Map<string, { typeName: string; library?: string }>();
  private repositoryPropertyTypes = new Map<string, string>();

  constructor() {
    super(
      'typescript-javascript-analyzer',
      'TypeScript/JavaScript AST Analyzer',
      '1.0.0',
      'language'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const files = await glob(['**/*.{js,jsx,ts,tsx,mjs,cjs}'], {
        cwd: projectPath,
        ignore: ['node_modules/**', 'dist/**', 'build/**', '.git/**']
      });
      return files.length > 0;
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
    const perspectives: CASPerspective[] = [];

    this.importSourceMap.clear();
    this.classFieldTypes.clear();
    this.repositoryPropertyTypes.clear();

    try {
      this.callGraphExtractor = new EnhancedCallGraphExtractor(context.projectPath);

      const sourceFiles = await glob(['**/*.{js,jsx,ts,tsx,mjs,cjs}'], {
        cwd: context.projectPath,
        ignore: ['node_modules/**', 'dist/**', 'build/**', '.git/**']
      });

      this.isTypeScriptProject = sourceFiles.filter(f => f.endsWith('.ts') || f.endsWith('.tsx')).length >
                                 sourceFiles.filter(f => f.endsWith('.js') || f.endsWith('.jsx')).length;

      const packageJsonPath = path.join(context.projectPath, 'package.json');
      if (await fs.pathExists(packageJsonPath)) {
        const packageJson = await fs.readJson(packageJsonPath);
        this.extractLibraries(packageJson, libraries);
      }

      for (const file of sourceFiles) {
        const fullPath = path.join(context.projectPath, file);
        await this.analyzeFile(fullPath, file, nodes, edges, entryPoints, exitPoints, context);
      }

      this.buildEnhancedCallGraph(nodes, edges, entryPoints, exitPoints);

      const categories = this.buildCategories();

      this.tagNodesWithPerspectives(nodes, edges);
      this.createPerspectives(perspectives);

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          isTypeScriptProject: this.isTypeScriptProject,
          libraries,
          filesAnalyzed: sourceFiles.length
        },
        categories,
        perspectives,
        provided_perspectives: perspectives.map(p => p.id)
      });

    } catch (error) {
      throw new AnalyzerError(
        `TypeScript/JavaScript analysis failed: ${(error as Error).message}`,
        'TYPESCRIPT_ANALYSIS_ERROR'
      );
    }
  }

  private async analyzeFile(
    fullPath: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[],
    exitPoints: any[],
    context: AnalysisContext
  ): Promise<void> {
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      const ast = parse(content, {
        loc: true,
        range: true,
        jsx: true,
        comment: true,
        tokens: true,
        useJSXTextNode: true,
        ecmaFeatures: { jsx: true },
        sourceType: 'module'
      });

      this.astCache.set(relativePath, { ast, content, filePath: fullPath });

      const fileId = `file_${relativePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const lines = content.split('\n');
      const fileComments = this.extractCommentsFromFile(content, fullPath);
      const fileTodos = this.extractTodosFromComments(fileComments, fullPath);

      nodes.push(this.createNode(
        fileId,
        path.basename(relativePath),
        'file',
        1,
        fullPath,
        1,
        lines.length,
        {
          relativePath,
          extension: path.extname(relativePath),
          isTypeScript: relativePath.endsWith('.ts') || relativePath.endsWith('.tsx'),
          commentCount: fileComments.length,
          todoCount: fileTodos.length,
          comments: fileComments.length > 0 ? fileComments : undefined,
          todos: fileTodos.length > 0 ? fileTodos : undefined
        }
      ));

      this.extractImports(ast, relativePath, nodes, edges, exitPoints);
      this.extractFunctions(ast, relativePath, nodes, edges, entryPoints, content, lines);
      this.extractClasses(ast, relativePath, nodes, edges, content, lines);
      this.extractVariables(ast, relativePath, nodes, content);
      this.extractExports(ast, relativePath, entryPoints);

      // Use enhanced call graph extractor for comprehensive analysis
      const { functions: extractedFunctions } = this.callGraphExtractor.extractFromAST(ast, fullPath);
      this.integrateEnhancedCallGraphData(extractedFunctions, nodes, edges, entryPoints, exitPoints, relativePath);

    } catch (error) {
      console.warn(`Failed to analyze ${relativePath}:`, error);
    }
  }

  private extractImports(
    ast: TSESTree.Program,
    filePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    exitPoints: any[]
  ): void {
    ast.body.forEach((node, index) => {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'ImportDeclaration' && node.source.type === 'Literal') {
        const importSource = node.source.value as string;
        const importId = `import_${filePath}_${index}`;

        const specifiers = this.getImportSpecifiers(node);
        specifiers.forEach((spec: { name: string; imported: string }) => {
          this.importSourceMap.set(spec.name, importSource);
        });

        nodes.push(this.createNode(
          importId,
          `import ${importSource}`,
          'import',
          3,
          filePath,
          node.loc?.start.line,
          node.loc?.end.line,
          { source: importSource, specifiers }
        ));

        const fileId = `file_${filePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
        edges.push(this.createEdge(
          `${fileId}_to_${importId}`,
          fileId,
          importId,
          'imports'
        ));

        if (!importSource.startsWith('.')) {
          exitPoints.push({
            id: `exit_${importId}`,
            name: `External dependency: ${importSource}`,
            type: 'library_import',
            source_node: importId,
            metadata: { library: importSource }
          });
        }
      }
    });
  }

  private extractFunctions(
    ast: TSESTree.Program,
    filePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[],
    content: string,
    lines: string[]
  ): void {
    const functions = this.findFunctionsInAST(ast, content, lines);
    const fileId = `file_${filePath.replace(/[^a-zA-Z0-9]/g, '_')}`;

    functions.forEach((func, index) => {
      const funcId = `function_${filePath}_${func.name}_${index}`;

      const node = this.createNodeBuilder(
        funcId,
        func.name,
        'function'
      )
        .withLevel(2, 'Class/Interface')
        .withCategory('functions', ['standalone'])
        .withSource({ file: filePath, line: func.lineStart, end_line: func.lineEnd })
        .withMetadata({
          is_exported: func.isExported,
          is_async: func.isAsync,
          is_generated: func.isGenerator,
          attributes: {
            functionType: func.type,
            hasDocumentation: !!func.documentation,
            todoCount: func.todos?.length || 0
          }
        })
        .withSignature({
          parameters: func.parameters,
          return_type: func.returnType
        })
        .withDocumentation(func.documentation)
        .withComments(func.comments)
        .withTodos(func.todos)
        .withImplementationStatus(func.implementationStatus)
        .build();

      nodes.push(node);

      edges.push(this.createEdge(
        `${fileId}_contains_${funcId}`,
        fileId,
        funcId,
        'contains'
      ));

      if (func.isExported) {
        entryPoints.push({
          id: `entry_${funcId}`,
          name: `Exported function: ${func.name}`,
          type: 'function_export',
          source_node: funcId,
          metadata: { functionType: func.type }
        });
      }
    });
  }

  private extractClasses(
    ast: TSESTree.Program,
    filePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    content: string,
    lines: string[]
  ): void {
    const classes = this.findClassesInAST(ast, content, lines);
    const fileId = `file_${filePath.replace(/[^a-zA-Z0-9]/g, '_')}`;

    classes.forEach((cls, index) => {
      const classId = `class_${filePath}_${cls.name}_${index}`;

      const classNode = this.createNodeBuilder(
        classId,
        cls.name,
        'class'
      )
        .withLevel(2, 'Class/Interface')
        .withCategory('structures', ['classes'])
        .withSource({ file: filePath, line: cls.lineStart, end_line: cls.lineEnd })
        .withMetadata({
          is_exported: cls.isExported,
          is_abstract: cls.isAbstract,
          attributes: {
            extends: cls.extends,
            implements: cls.implements,
            methodCount: cls.methods.length,
            propertyCount: cls.properties.length,
            hasDocumentation: !!cls.documentation
          }
        })
        .withDocumentation(cls.documentation)
        .withComments(cls.comments)
        .build();

      nodes.push(classNode);

      edges.push(this.createEdge(
        `${fileId}_contains_${classId}`,
        fileId,
        classId,
        'contains'
      ));

      cls.methods.forEach((method, methodIndex) => {
        const methodId = `method_${classId}_${method.name}_${methodIndex}`;

        const methodNode = this.createNodeBuilder(
          methodId,
          method.name,
          'method'
        )
          .withLevel(3, 'Method/Function')
          .withCategory('methods', ['class-methods'])
          .withSource({ file: filePath, line: method.lineStart, end_line: method.lineEnd })
          .withMetadata({
            is_async: method.isAsync,
            is_generated: method.isGenerator,
            attributes: {
              methodType: method.type,
              hasDocumentation: !!method.documentation,
              todoCount: method.todos?.length || 0
            }
          })
          .withSignature({
            parameters: method.parameters,
            return_type: method.returnType
          })
          .withParent(classId)
          .withDocumentation(method.documentation)
          .withComments(method.comments)
          .withTodos(method.todos)
          .withImplementationStatus(method.implementationStatus)
          .build();

        nodes.push(methodNode);

        edges.push(this.createEdge(
          `${classId}_contains_${methodId}`,
          classId,
          methodId,
          'contains'
        ));
      });

      cls.properties.forEach((prop, propIndex) => {
        const propertyId = `property_${classId}_${prop.name}_${propIndex}`;

        const decoratorNames = prop.decorators?.map(d => d.name) || [];
        const annotations = prop.decorators?.map(d => {
          if (d.arguments && d.arguments.length > 0) {
            return `@${d.name}(${JSON.stringify(d.arguments[0])})`;
          }
          return `@${d.name}()`;
        }) || [];

        const propertyNode = this.createNodeBuilder(
          propertyId,
          prop.name,
          'property'
        )
          .withLevel(4, 'Variable/Property')
          .withCategory('data', ['class-properties'])
          .withSource({ file: filePath, line: prop.lineStart, end_line: prop.lineEnd })
          .withMetadata({
            annotations: annotations.length > 0 ? annotations : undefined,
            attributes: {
              propertyType: prop.type,
              isStatic: prop.isStatic,
              isPrivate: prop.isPrivate,
              hasDocumentation: !!prop.documentation,
              decorators: decoratorNames.length > 0 ? decoratorNames : undefined
            }
          })
          .withSignature({
            return_type: prop.type
          })
          .withParent(classId)
          .withDocumentation(prop.documentation)
          .build();

        nodes.push(propertyNode);

        edges.push(this.createEdge(
          `${classId}_contains_${propertyId}`,
          classId,
          propertyId,
          'contains'
        ));
      });
    });
  }

  private extractVariables(ast: TSESTree.Program, filePath: string, nodes: CASNode[], content: string): void {
    const variables = this.findVariablesInAST(ast, content);
    const fileId = `file_${filePath.replace(/[^a-zA-Z0-9]/g, '_')}`;

    variables.forEach((variable, index) => {
      const variableId = `variable_${filePath}_${variable.name}_${index}`;

      nodes.push(this.createNodeBuilder(
        variableId,
        variable.name,
        'variable'
      )
        .withLevel(4, 'Variable/Property')
        .withCategory('data', ['variables'])
        .withSource({ file: filePath, line: variable.line })
        .withMetadata({
          is_exported: variable.isExported,
          attributes: {
            variableType: variable.type,
            kind: variable.kind,
            value: variable.value
          }
        })
        .build());
    });
  }

  private extractExports(ast: TSESTree.Program, filePath: string, entryPoints: any[]): void {
    ast.body.forEach((node, index) => {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration') {
        const exportId = `export_${filePath}_${index}`;

        entryPoints.push({
          id: exportId,
          name: `Export from ${path.basename(filePath)}`,
          type: node.type === 'ExportDefaultDeclaration' ? 'default_export' : 'named_export',
          source_node: `file_${filePath.replace(/[^a-zA-Z0-9]/g, '_')}`,
          metadata: {
            line: node.loc?.start.line,
            exportType: node.type
          }
        });
      }
    });
  }

  private extractLibraries(packageJson: any, libraries: any[]): void {
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

    Object.entries(deps).forEach(([name, version]) => {
      libraries.push({
        name,
        version: version as string,
        type: 'npm_package',
        source: 'package.json',
        metadata: {
          isDev: !!packageJson.devDependencies?.[name],
          isProduction: !!packageJson.dependencies?.[name]
        }
      });
    });
  }

  private findFunctionsInAST(ast: TSESTree.Program, content: string, lines: string[]): FunctionInfo[] {
    const functions: FunctionInfo[] = [];
    const visited = new WeakSet();

    const walk = (node: any, parent?: any) => {
      if (!node || typeof node !== 'object') return;
      if (visited.has(node)) return;
      visited.add(node);


      if (node.type === 'FunctionDeclaration' && node.id) {
        const jsdoc = this.extractJSDoc(node, content, lines);
        const comments = this.extractNodeComments(node, content, lines);
        const todos = this.extractTodosFromComments(comments, node.loc?.start.line?.toString() || '');
        const status = this.detectImplementationStatus(node, content);

        functions.push({
          name: node.id.name,
          type: node.async ? 'async' : node.generator ? 'function' : 'function',
          parameters: this.extractParameters(node.params, jsdoc),
          returnType: this.extractReturnType(node.returnType, jsdoc),
          lineStart: node.loc?.start.line || 0,
          lineEnd: node.loc?.end.line || 0,
          isExported: parent?.type === 'ExportNamedDeclaration' || parent?.type === 'ExportDefaultDeclaration',
          isAsync: node.async || false,
          isGenerator: node.generator || false,
          documentation: jsdoc,
          comments: comments.length > 0 ? comments : undefined,
          todos: todos.length > 0 ? todos : undefined,
          implementationStatus: status,
          decorators: this.extractDecorators(node)
        });
      }

      if (!node || typeof node !== 'object') return;

      if (node.type === 'VariableDeclaration') {
        node.declarations.forEach((decl: any) => {
          if (decl.init?.type === 'ArrowFunctionExpression' && decl.id?.name) {
            const jsdoc = this.extractJSDoc(node, content, lines);
            const comments = this.extractNodeComments(decl.init, content, lines);
            const todos = this.extractTodosFromComments(comments, decl.init.loc?.start.line?.toString() || '');
            const status = this.detectImplementationStatus(decl.init, content);

            functions.push({
              name: decl.id.name,
              type: 'arrow',
              parameters: this.extractParameters(decl.init.params, jsdoc),
              returnType: this.extractReturnType(decl.init.returnType, jsdoc),
              lineStart: decl.init.loc?.start.line || 0,
              lineEnd: decl.init.loc?.end.line || 0,
              isExported: parent?.type === 'ExportNamedDeclaration',
              isAsync: decl.init.async || false,
              isGenerator: false,
              documentation: jsdoc,
              comments: comments.length > 0 ? comments : undefined,
              todos: todos.length > 0 ? todos : undefined,
              implementationStatus: status
            });
          }
        });
      }

      if (!node || typeof node !== 'object') return;

      if (node.type === 'MethodDefinition') {
        const jsdoc = this.extractJSDoc(node, content, lines);
        const comments = this.extractNodeComments(node, content, lines);
        const todos = this.extractTodosFromComments(comments, node.loc?.start.line?.toString() || '');
        const status = this.detectImplementationStatus(node.value, content);

        functions.push({
          name: node.key.name || 'method',
          type: node.kind === 'constructor' ? 'constructor' : 'method',
          parameters: this.extractParameters(node.value.params, jsdoc),
          returnType: this.extractReturnType(node.value.returnType, jsdoc),
          lineStart: node.loc?.start.line || 0,
          lineEnd: node.loc?.end.line || 0,
          isExported: false,
          isAsync: node.value.async || false,
          isGenerator: node.value.generator || false,
          documentation: jsdoc,
          comments: comments.length > 0 ? comments : undefined,
          todos: todos.length > 0 ? todos : undefined,
          implementationStatus: status,
          decorators: this.extractDecorators(node)
        });
      }

      for (const key in node) {
        if (key === 'parent') continue;

        if (Array.isArray(node[key])) {
          node[key].forEach((child: any) => walk(child, node));
        } else if (typeof node[key] === 'object') {
          walk(node[key], node);
        }
      }
    };

    walk(ast, null);
    return functions;
  }

  private findClassesInAST(ast: TSESTree.Program, content: string, lines: string[]): ClassInfo[] {
    const classes: ClassInfo[] = [];
    const visited = new WeakSet();

    const walk = (node: any, parent?: any) => {
      if (!node || typeof node !== 'object') return;
      if (visited.has(node)) return;
      visited.add(node);


      if (node.type === 'ClassDeclaration' && node.id) {
        const classJsdoc = this.extractJSDoc(node, content, lines);
        const classComments = this.extractNodeComments(node, content, lines);

        const methods = node.body.body
          .filter((member: any) => member.type === 'MethodDefinition')
          .map((method: any) => {
            const methodJsdoc = this.extractJSDoc(method, content, lines);
            const methodComments = this.extractNodeComments(method, content, lines);
            const methodTodos = this.extractTodosFromComments(methodComments, method.loc?.start.line?.toString() || '');
            const methodStatus = this.detectImplementationStatus(method.value, content);

            return {
              name: method.key.name || 'method',
              type: method.kind === 'constructor' ? 'constructor' as const : 'method' as const,
              parameters: this.extractParameters(method.value.params, methodJsdoc),
              returnType: this.extractReturnType(method.value.returnType, methodJsdoc),
              lineStart: method.loc?.start.line || 0,
              lineEnd: method.loc?.end.line || 0,
              isExported: false,
              isAsync: method.value.async || false,
              isGenerator: method.value.generator || false,
              documentation: methodJsdoc,
              comments: methodComments.length > 0 ? methodComments : undefined,
              todos: methodTodos.length > 0 ? methodTodos : undefined,
              implementationStatus: methodStatus,
              decorators: this.extractDecorators(method)
            };
          });

        const properties = node.body.body
          .filter((member: any) => member.type === 'PropertyDefinition')
          .map((prop: any) => {
            const propJsdoc = this.extractJSDoc(prop, content, lines);
            return {
              name: prop.key.name || 'property',
              type: this.extractTypeFromAnnotation(prop.typeAnnotation),
              isStatic: prop.static || false,
              isPrivate: prop.accessibility === 'private',
              documentation: propJsdoc,
              decorators: this.extractDecorators(prop),
              lineStart: prop.loc?.start.line || 0,
              lineEnd: prop.loc?.end.line || 0
            };
          });

        classes.push({
          name: node.id.name,
          extends: node.superClass?.name,
          implements: node.implements?.map((impl: any) => impl.expression?.name || 'unknown') || [],
          methods,
          properties,
          lineStart: node.loc?.start.line || 0,
          lineEnd: node.loc?.end.line || 0,
          isExported: parent?.type === 'ExportNamedDeclaration' || parent?.type === 'ExportDefaultDeclaration',
          isAbstract: node.abstract || false,
          documentation: classJsdoc,
          decorators: this.extractDecorators(node),
          comments: classComments.length > 0 ? classComments : undefined
        });
      }

      for (const key in node) {
        if (key === 'parent') continue;

        if (Array.isArray(node[key])) {
          node[key].forEach((child: any) => walk(child, node));
        } else if (typeof node[key] === 'object') {
          walk(node[key], node);
        }
      }
    };

    walk(ast, null);
    return classes;
  }

  private findVariablesInAST(ast: TSESTree.Program, content: string): VariableInfo[] {
    const variables: VariableInfo[] = [];
    const visited = new WeakSet();

    const walk = (node: any, parent?: any) => {
      if (!node || typeof node !== 'object') return;
      if (visited.has(node)) return;
      visited.add(node);


      if (node.type === 'VariableDeclaration') {
        node.declarations.forEach((declaration: any) => {
          if (declaration.id && declaration.id.name &&
              declaration.init?.type !== 'ArrowFunctionExpression' &&
              declaration.init?.type !== 'FunctionExpression') {
            variables.push({
              name: declaration.id.name,
              type: this.extractTypeFromAnnotation(declaration.id.typeAnnotation),
              value: this.extractLiteralValue(declaration.init),
              kind: node.kind,
              line: node.loc?.start.line || 0,
              isExported: parent?.type === 'ExportNamedDeclaration'
            });
          }
        });
      }

      for (const key in node) {
        if (key === 'parent') continue;

        if (Array.isArray(node[key])) {
          node[key].forEach((child: any) => walk(child, node));
        } else if (typeof node[key] === 'object') {
          walk(node[key], node);
        }
      }
    };

    walk(ast, null);
    return variables;
  }

  private getImportSpecifiers(node: TSESTree.ImportDeclaration): any[] {
    return node.specifiers.map(spec => {
      if (spec.type === 'ImportDefaultSpecifier') {
        return { name: spec.local.name, imported: 'default' };
      } else if (spec.type === 'ImportSpecifier') {
        return {
          name: spec.local.name,
          imported: spec.imported.type === 'Identifier' ? spec.imported.name : spec.local.name
        };
      } else if (spec.type === 'ImportNamespaceSpecifier') {
        return { name: spec.local.name, imported: '*' };
      }
      return { name: 'unknown', imported: 'unknown' };
    });
  }

  private buildEnhancedCallGraph(nodes: CASNode[], edges: CASEdge[], entryPoints: CASEntryPoint[], exitPoints: CASExitPoint[]): void {
    // Legacy method calls are now handled by integrateEnhancedCallGraphData
    // This method now focuses on final integration and validation
    this.validateCallGraph(nodes, edges);
    this.enrichNodesWithCallData(nodes, edges);
  }

  private integrateEnhancedCallGraphData(
    extractedFunctions: any[],
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    filePath: string
  ): void {
    extractedFunctions.forEach(func => {
      // HTTP endpoints from decorators
      func.calls.forEach((call: any) => {
        if (call.httpMethod && call.httpPath) {
          const sourceNodeId = this.resolveSourceNodeId(filePath, func, nodes);
          if (sourceNodeId) {
            entryPoints.push({
              id: `http_${func.name}_${call.httpMethod}`,
              source_node: sourceNodeId,
              type: 'http',
              name: `${call.httpMethod} ${call.httpPath}`,
              trigger: {
                method: call.httpMethod,
                path: call.httpPath
              },
              metadata: {
                decorators: call.decorators,
                framework: 'nestjs'
              }
            });
          }
        }

        // Library calls as exit points
        if (call.targetType === 'library' && call.library) {
          const exitSourceNodeId = this.resolveSourceNodeId(filePath, func, nodes);
          if (exitSourceNodeId) {
            exitPoints.push({
              id: `exit_${func.name}_${call.target}`,
              source_node: exitSourceNodeId,
              type: 'sdk',
              name: `${call.library}.${call.target.split('.').pop()}`,
              target: {
                sdk: call.library,
                endpoint: call.target.split('.').pop() || call.target
              },
              operation: {
                action: call.target.split('.').pop() || call.target,
                async: call.isAsync
              },
              metadata: {
                line: call.line,
                call_expression: call.callExpression
              }
            });
          }
        }

        // Abstract method calls
        if (call.targetType === 'abstract') {
          const sourceNodeId = this.resolveSourceNodeId(filePath, func, nodes);
          const targetNodeId = this.findNodeIdByName(call.target, nodes);

          if (sourceNodeId && targetNodeId) {
            edges.push({
              id: `abstract_call_${sourceNodeId}_${targetNodeId}`,
              source: sourceNodeId,
              target: targetNodeId,
              type: 'calls',
              metadata: {
                attributes: {
                  call_type: 'abstract',
                  is_async: call.isAsync,
                  line: call.line,
                  method_name: call.target.split('.').pop()
                }
              }
            });
          }
        }

        // Dependency injection calls
        if (call.injectionType) {
          const sourceNodeId = this.resolveSourceNodeId(filePath, func, nodes);
          const targetNodeId = this.findNodeIdByName(call.target, nodes);

          if (sourceNodeId && targetNodeId) {
            edges.push({
              id: `injection_${sourceNodeId}_${targetNodeId}`,
              source: sourceNodeId,
              target: targetNodeId,
              type: 'calls',
              metadata: {
                attributes: {
                  call_type: 'injection',
                  injection_type: call.injectionType,
                  line: call.line
                }
              }
            });
          }
        }

        // Regular method/function calls
        if (call.targetType === 'method' || call.targetType === 'function') {
          const sourceNodeId = this.resolveSourceNodeId(filePath, func, nodes);
          const targetNodeId = this.findNodeIdByName(call.target, nodes);

          if (sourceNodeId && targetNodeId && sourceNodeId !== targetNodeId) {
            edges.push({
              id: `call_${sourceNodeId}_${targetNodeId}`,
              source: sourceNodeId,
              target: targetNodeId,
              type: 'calls',
              metadata: {
                attributes: {
                  call_type: call.targetType,
                  is_async: call.isAsync,
                  is_conditional: call.isConditional,
                  is_in_loop: call.isInLoop,
                  line: call.line
                }
              }
            });
          } else if (sourceNodeId && !targetNodeId && this.isRepositoryCall(call.target)) {
            const repoInfo = this.parseRepositoryCall(call.target);
            if (repoInfo) {
              const library = this.getLibraryForType('EntityRepository')
                || this.getLibraryForType('Repository')
                || this.getLibraryForType('PrismaClient')
                || this.getLibraryForType('Model');
              exitPoints.push({
                id: `exit_db_${func.name}_${repoInfo.method}_${call.line}`,
                source_node: sourceNodeId,
                type: 'database',
                name: `${repoInfo.repository}.${repoInfo.method}`,
                target: {
                  service_id: 'database',
                  resource: repoInfo.repository
                },
                operation: {
                  action: repoInfo.method,
                  async: call.isAsync
                },
                metadata: {
                  repository: repoInfo.repository,
                  method: repoInfo.method,
                  line: call.line,
                  call_expression: call.callExpression,
                  library
                }
              });
            }
          }
        }
      });
    });
  }

  private isRepositoryCall(target: string): boolean {
    if (!target.includes('.')) return false;
    const lowerTarget = target.toLowerCase();
    return lowerTarget.includes('repository') ||
           lowerTarget.includes('repo') ||
           this.isCommonRepoMethod(target.split('.').pop() || '');
  }

  private isCommonRepoMethod(methodName: string): boolean {
    const repoMethods = [
      'find', 'findone', 'findoneorfail', 'findall', 'findandcount',
      'create', 'save', 'insert', 'persist', 'persistandflush',
      'update', 'upsert', 'nativeupdate',
      'delete', 'remove', 'removeandflush', 'nativedelete',
      'flush', 'count', 'getreference', 'populate', 'assign'
    ];
    return repoMethods.includes(methodName.toLowerCase());
  }

  private parseRepositoryCall(target: string): { repository: string; method: string } | null {
    const parts = target.split('.');
    if (parts.length < 2) return null;

    const method = parts.pop()!;
    let repository = parts.pop()!;

    if (repository === 'this' && parts.length > 0) {
      repository = parts.pop()!;
    }

    return {
      repository: this.propertyNameToClassName(repository),
      method
    };
  }

  private getLibraryFromImportSource(importSource: string): string {
    if (importSource.includes('@mikro-orm')) return 'MikroORM';
    if (importSource.includes('typeorm')) return 'TypeORM';
    if (importSource.includes('@prisma')) return 'Prisma';
    if (importSource.includes('sequelize')) return 'Sequelize';
    if (importSource.includes('mongoose')) return 'Mongoose';
    if (importSource.includes('knex')) return 'Knex';
    if (importSource.includes('drizzle')) return 'Drizzle';
    if (importSource.includes('objection')) return 'Objection.js';
    return importSource;
  }

  private getLibraryForType(typeName: string): string | undefined {
    const importSource = this.importSourceMap.get(typeName);
    if (importSource) {
      return this.getLibraryFromImportSource(importSource);
    }

    if (typeName.includes('EntityRepository')) {
      const entityRepoSource = this.importSourceMap.get('EntityRepository');
      if (entityRepoSource) {
        return this.getLibraryFromImportSource(entityRepoSource);
      }
    }

    return undefined;
  }

  private findNodeIdByName(targetName: string, nodes: CASNode[]): string | undefined {
    if (this.isRepositoryCall(targetName)) {
      const parts = targetName.split('.');
      if (parts.length >= 3 && parts[0] === 'this') {
        const repositoryProperty = parts[1];
        const methodName = parts.slice(2).join('.');

        const repositoryClassName = this.getRepositoryClassNameFromProperty(repositoryProperty);
        if (repositoryClassName) {
          const targetNode = nodes.find(n =>
            n.type === 'method' &&
            n.name === methodName &&
            n.parent && nodes.find(p => p.id === n.parent && p.name === repositoryClassName)
          );
          if (targetNode) return targetNode.id;
        }
      }
      return undefined;
    }

    let targetNode = nodes.find(n => n.name === targetName);
    if (targetNode) return targetNode.id;

    if (!targetName.includes('.')) {
      targetNode = nodes.find(n => n.name === targetName && (n.type === 'function' || n.type === 'method'));
      return targetNode?.id;
    }

    const parts = targetName.split('.');
    const methodName = parts.pop();
    if (!methodName) return undefined;

    if (parts[0] === 'this' && parts.length >= 2) {
      const propertyName = parts[1];
      const expectedClassName = this.propertyNameToClassName(propertyName);

      targetNode = nodes.find(n => {
        if (n.name !== methodName || n.type !== 'method') return false;

        const parentClass = nodes.find(p => p.id === n.parent && p.type === 'class');
        if (!parentClass) return false;

        return parentClass.name.toLowerCase() === expectedClassName.toLowerCase() ||
               parentClass.name.toLowerCase().includes(propertyName.toLowerCase());
      });

      if (targetNode) return targetNode.id;

      const classNode = nodes.find(n =>
        n.type === 'class' &&
        (n.name.toLowerCase() === expectedClassName.toLowerCase() ||
         n.name.toLowerCase().includes(propertyName.toLowerCase()))
      );
      if (classNode) {
        targetNode = nodes.find(n =>
          n.name === methodName &&
          n.type === 'method' &&
          n.parent === classNode.id
        );
        if (targetNode) return targetNode.id;
      }
    }

    const objectName = parts.join('.');
    targetNode = nodes.find(n => {
      if (n.name !== methodName || n.type !== 'method') return false;
      const parentClass = nodes.find(p => p.id === n.parent && p.type === 'class');
      if (!parentClass) return false;
      return parentClass.name.toLowerCase().includes(objectName.toLowerCase().replace('this.', ''));
    });

    return targetNode?.id;
  }

  private propertyNameToClassName(propertyName: string): string {
    return propertyName.charAt(0).toUpperCase() + propertyName.slice(1);
  }

  private getRepositoryClassNameFromProperty(propertyName: string): string | undefined {
    return this.repositoryPropertyTypes.get(propertyName);
  }

  private resolveSourceNodeId(
    filePath: string,
    func: ExtractedFunction,
    nodes: CASNode[]
  ): string | undefined {
    if (func.className) {
      const classId = `class_${filePath}_${func.className}_0`;
      const methodNode = nodes.find(n =>
        n.name === func.name &&
        n.type === 'method' &&
        n.parent === classId
      );
      if (methodNode) return methodNode.id;

      const classNode = nodes.find(n => n.id === classId);
      if (classNode) {
        const anyMethodInClass = nodes.find(n =>
          n.type === 'method' &&
          n.parent === classId &&
          n.name === func.name
        );
        if (anyMethodInClass) return anyMethodInClass.id;
      }

      return undefined;
    }
    const funcNode = nodes.find(n =>
      n.name === func.name &&
      n.type === 'function' &&
      n.id.startsWith(`function_${filePath}`)
    );
    if (funcNode) return funcNode.id;

    return undefined;
  }

  private validateCallGraph(nodes: CASNode[], edges: CASEdge[]): void {
    const nodeIds = new Set(nodes.map(n => n.id));

    edges.forEach((edge, index) => {
      if (!nodeIds.has(edge.source) && !edge.source.startsWith('exit_') && !edge.source.startsWith('library_')) {
        console.warn(`Edge ${edge.id} has invalid source: ${edge.source}`);
      }
      if (!nodeIds.has(edge.target) && !edge.target.startsWith('exit_') && !edge.target.startsWith('library_')) {
        console.warn(`Edge ${edge.id} has invalid target: ${edge.target}`);
      }
    });

    this.createClassLevelEdges(nodes, edges);
  }

  private createClassLevelEdges(nodes: CASNode[], edges: CASEdge[]): void {
    const classLikeTypes = new Set(['class', 'service', 'controller', 'repository', 'guard', 'gateway']);
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const classEdges = new Map<string, { sourceClass: string; targetClass: string; methodEdgeIds: string[] }>();

    edges.forEach(edge => {
      if (edge.type !== 'calls') return;

      const sourceNode = nodeMap.get(edge.source);
      const targetNode = nodeMap.get(edge.target);
      if (!sourceNode || !targetNode) return;

      const sourceClassId = sourceNode.parent;
      const targetClassId = targetNode.parent;
      if (!sourceClassId || !targetClassId) return;
      if (sourceClassId === targetClassId) return;

      const sourceClassNode = nodeMap.get(sourceClassId);
      const targetClassNode = nodeMap.get(targetClassId);
      if (!sourceClassNode || !targetClassNode) return;
      if (!classLikeTypes.has(sourceClassNode.type) || !classLikeTypes.has(targetClassNode.type)) return;

      const edgeKey = `${sourceClassId}_uses_${targetClassId}`;
      const existing = classEdges.get(edgeKey);
      if (existing) {
        existing.methodEdgeIds.push(edge.id);
      } else {
        classEdges.set(edgeKey, {
          sourceClass: sourceClassId,
          targetClass: targetClassId,
          methodEdgeIds: [edge.id]
        });
      }
    });

    classEdges.forEach((data, key) => {
      edges.push({
        id: key,
        source: data.sourceClass,
        target: data.targetClass,
        type: 'uses',
        metadata: {
          attributes: {
            aggregated_from: data.methodEdgeIds,
            call_count: data.methodEdgeIds.length
          }
        }
      });
    });
  }

  private enrichNodesWithCallData(nodes: CASNode[], edges: CASEdge[]): void {
    // Enrich nodes with call statistics
    const callCounts = new Map<string, { incoming: number; outgoing: number }>();

    edges.forEach(edge => {
      if (edge.type === 'calls') {
        // Outgoing calls
        const sourceStats = callCounts.get(edge.source) || { incoming: 0, outgoing: 0 };
        sourceStats.outgoing++;
        callCounts.set(edge.source, sourceStats);

        // Incoming calls
        const targetStats = callCounts.get(edge.target) || { incoming: 0, outgoing: 0 };
        targetStats.incoming++;
        callCounts.set(edge.target, targetStats);
      }
    });

    nodes.forEach(node => {
      const stats = callCounts.get(node.id);
      if (stats) {
        if (!node.metadata) node.metadata = {};
        if (!node.metadata.attributes) node.metadata.attributes = {};

        node.metadata.attributes.incoming_calls = stats.incoming;
        node.metadata.attributes.outgoing_calls = stats.outgoing;
        node.metadata.attributes.is_leaf = stats.outgoing === 0;
        node.metadata.attributes.is_entry = stats.incoming === 0;
      }
    });
  }

  private extractConstructorDependencyEdges(
    ast: TSESTree.Program,
    filePath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    const visited = new WeakSet();

    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;

      if (visited.has(node)) return;
      visited.add(node);

      if (!node || typeof node !== 'object') return;

      if (node.type === 'ClassDeclaration' && node.id) {
        const className = node.id.name;
        const classId = `class_${filePath}_${className}_0`;
        const classNode = nodes.find(n => n.id === classId);

        if (!classNode) return;

        const constructor = node.body?.body?.find((member: any) =>
          member.type === 'MethodDefinition' && member.kind === 'constructor'
        );

        if (constructor?.value?.params) {
          constructor.value.params.forEach((param: any, index: number) => {
            const paramName = param.type === 'TSParameterProperty'
              ? param.parameter?.name
              : param.name;
            const typeAnnotation = param.type === 'TSParameterProperty'
              ? param.parameter?.typeAnnotation?.typeAnnotation
              : param.typeAnnotation?.typeAnnotation;

            if (typeAnnotation) {
              const depType = this.extractTypeNameFromAnnotation(typeAnnotation);
              if (depType && paramName) {
                const library = this.getLibraryForType(depType);
                this.classFieldTypes.set(`${className}.${paramName}`, {
                  typeName: depType,
                  library
                });

                if (depType.includes('Repository')) {
                  const paramNameStr = typeof paramName === 'string' ? paramName : paramName.name;
                  if (paramNameStr) {
                    this.repositoryPropertyTypes.set(paramNameStr, depType);
                  }
                }
              }
            }

            if (param.typeAnnotation?.typeAnnotation) {
              const depType = this.extractTypeNameFromAnnotation(param.typeAnnotation.typeAnnotation);
              if (depType) {
                // First try to find by exact match with various types
                let depNode = nodes.find(n =>
                  n.name === depType &&
                  (n.type === 'class' || n.type === 'service' || n.type === 'repository' ||
                   n.type === 'controller' || n.type === 'guard' || n.type === 'middleware')
                );

                // If not found, try to find any class with that name
                if (!depNode) {
                  depNode = nodes.find(n => n.name === depType && n.type === 'class');
                }

                // Also look for interfaces that might be implemented by a service
                if (!depNode && depType.endsWith('Service')) {
                  depNode = nodes.find(n =>
                    n.name === depType.replace('Service', 'ServiceImpl') ||
                    n.name === depType.replace('Service', 'ServiceImplementation')
                  );
                }

                if (depNode) {
                  const edgeId = `${classId}_depends_on_${depNode.id}_injection_${index}`;
                  if (!edges.find(e => e.id === edgeId)) {
                    edges.push(this.createEdge(
                      edgeId,
                      classId,
                      depNode.id,
                      'depends_on',
                      'dependency',
                      {
                        injection_type: 'constructor',
                        from_constructor: true,
                        parameter_index: index,
                        parameter_name: param.name || `param${index}`,
                        injected_type: depType
                      }
                    ));
                  }
                }
              }
            }
          });
        }

        // Also look for property-based injection (e.g., @Inject decorators)
        if (node.body?.body) {
          node.body.body.forEach((member: any) => {
            if (member.type === 'PropertyDefinition' && member.typeAnnotation?.typeAnnotation) {
              const propType = this.extractTypeNameFromAnnotation(member.typeAnnotation.typeAnnotation);
              const propName = member.key?.name;
              if (propType && propName) {
                const library = this.getLibraryForType(propType);
                this.classFieldTypes.set(`${className}.${propName}`, {
                  typeName: propType,
                  library
                });
              }
              if (propType) {
                const depNode = nodes.find(n =>
                  n.name === propType &&
                  (n.type === 'class' || n.type === 'service' || n.type === 'repository')
                );

                if (depNode && member.decorators?.some((d: any) => d.expression?.callee?.name === 'Inject')) {
                  const edgeId = `${classId}_depends_on_${depNode.id}_prop_injection`;
                  if (!edges.find(e => e.id === edgeId)) {
                    edges.push(this.createEdge(
                      edgeId,
                      classId,
                      depNode.id,
                      'depends_on',
                      'dependency',
                      {
                        injection_type: 'property',
                        property_name: member.key?.name,
                        injected_type: propType
                      }
                    ));
                  }
                }
              }
            }
          });
        }
      }

      for (const key in node) {
        if (key === 'parent') continue; // Skip parent references to avoid circular recursion

        if (Array.isArray(node[key])) {
          node[key].forEach(walk);
        } else if (typeof node[key] === 'object') {
          walk(node[key]);
        }
      }
    };

    walk(ast);
  }

  private extractAllCallExpressions(
    ast: TSESTree.Program,
    filePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[]
  ): void {

    interface CallContext {
      containingClass?: string;
      containingMethod?: string;
      containingFunction?: string;
      containingNode?: CASNode;
    }

    const findNodeForContext = (ctx: CallContext): CASNode | undefined => {
      if (ctx.containingMethod && ctx.containingClass) {
        return nodes.find(n =>
          n.name === ctx.containingMethod &&
          n.type === 'method' &&
          edges.some(e => e.type === 'has_method' && e.target === n.id && e.source.includes(ctx.containingClass || ''))
        );
      }
      if (ctx.containingFunction) {
        return nodes.find(n =>
          n.name === ctx.containingFunction &&
          n.type === 'function'
        );
      }
      return undefined;
    };

    const extractCallInfo = (node: any, containingClass?: string): {target?: string, method?: string, isLibrary?: boolean, callType?: string, library?: string} => {
      if (node.callee.type === 'MemberExpression') {
        const getObjectName = (obj: any): string | null => {
          if (obj.type === 'Identifier') return obj.name;
          if (obj.type === 'ThisExpression') return 'this';
          if (obj.type === 'MemberExpression') {
            const baseObj = getObjectName(obj.object);
            if (baseObj) return `${baseObj}.${obj.property?.name || 'unknown'}`;
          }
          if (obj.type === 'CallExpression') return 'call_result';
          return null;
        };

        const objectName = getObjectName(node.callee.object);
        const methodName = node.callee.property?.name || 'unknown';

        const commonLibraries = ['fs', 'path', 'http', 'https', 'crypto', 'os', 'util', 'stream',
                               'console', 'process', 'Buffer', 'Promise', 'Array', 'Object',
                               'String', 'Number', 'Math', 'Date', 'JSON', 'RegExp'];

        let isLibrary = commonLibraries.some(lib => objectName?.startsWith(lib));
        let library: string | undefined;

        if (objectName?.startsWith('this.') && containingClass) {
          const fieldName = objectName.replace('this.', '').split('.')[0];
          const fieldKey = `${containingClass}.${fieldName}`;
          const fieldInfo = this.classFieldTypes.get(fieldKey);
          if (fieldInfo?.library) {
            isLibrary = true;
            library = fieldInfo.library;
          }
        }

        return {
          target: objectName || undefined,
          method: methodName,
          isLibrary,
          library,
          callType: objectName === 'this' ? 'internal' : isLibrary ? 'library' : 'external'
        };
      } else if (node.callee.type === 'Identifier') {
        return {
          method: node.callee.name,
          callType: 'function'
        };
      } else if (node.callee.type === 'CallExpression') {
        return {
          method: 'dynamic_call',
          callType: 'dynamic'
        };
      }
      return {};
    };

    const visited = new WeakSet();

    const walk = (node: any, context: CallContext = {}): void => {
      if (!node || typeof node !== 'object') return;
      if (visited.has(node)) return;
      visited.add(node);

      let currentContext = {...context};

      if (!node || typeof node !== 'object') return;

      if (node.type === 'ClassDeclaration' && node.id) {
        currentContext.containingClass = node.id.name;
        currentContext.containingMethod = undefined;
        currentContext.containingFunction = undefined;
      } else if (node.type === 'MethodDefinition' && node.key?.name) {
        currentContext.containingMethod = node.key.name;
        currentContext.containingFunction = undefined;
        currentContext.containingNode = findNodeForContext(currentContext);

        if (node.decorators && currentContext.containingNode) {
          node.decorators.forEach((decorator: any) => {
            if (decorator.expression?.type === 'CallExpression' &&
                decorator.expression.callee?.type === 'Identifier') {
              const decoratorName = decorator.expression.callee.name;
              const httpMethods = ['Get', 'Post', 'Put', 'Delete', 'Patch', 'Options', 'Head'];

              if (httpMethods.includes(decoratorName)) {
                const routePath = decorator.expression.arguments?.[0]?.value || '/';
                entryPoints.push({
                  id: `entry_http_${currentContext.containingNode!.id}`,
                  source_node: currentContext.containingNode!.id,
                  type: 'http',
                  name: `HTTP ${decoratorName.toUpperCase()} ${routePath}`,
                  trigger: {
                    method: decoratorName.toUpperCase(),
                    path: routePath
                  },
                  metadata: {
                    decorator: decoratorName,
                    framework: 'nestjs'
                  }
                } as CASEntryPoint);

                if (!currentContext.containingNode!.metadata) {
                  currentContext.containingNode!.metadata = {};
                }
                if (!currentContext.containingNode!.metadata.attributes) {
                  currentContext.containingNode!.metadata.attributes = {};
                }
                currentContext.containingNode!.metadata.attributes.httpEndpoint = true;
                currentContext.containingNode!.metadata.attributes.httpMethod = decoratorName.toUpperCase();
                currentContext.containingNode!.metadata.attributes.httpPath = routePath;
              }
            }
          });
        }
      } else if (node.type === 'FunctionDeclaration' && node.id) {
        currentContext.containingFunction = node.id.name;
        currentContext.containingClass = undefined;
        currentContext.containingMethod = undefined;
        currentContext.containingNode = findNodeForContext(currentContext);
      } else if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
        if (node.parent?.type === 'VariableDeclarator' && node.parent.id?.type === 'Identifier') {
          currentContext.containingFunction = node.parent.id.name;
          currentContext.containingClass = undefined;
          currentContext.containingMethod = undefined;
          currentContext.containingNode = findNodeForContext(currentContext);
        }
      }

      if (!node || typeof node !== 'object') return;

      if (node.type === 'CallExpression') {
        const callInfo = extractCallInfo(node, currentContext.containingClass);
        const callerNode = currentContext.containingNode;

        if (callerNode && callInfo.method) {
          if (callInfo.isLibrary) {
            const exitPointId = `exit_${callerNode.id}_to_${callInfo.target}_${callInfo.method}`;
            exitPoints.push({
              id: exitPointId,
              source_node: callerNode.id,
              type: 'sdk',
              name: `Call to ${callInfo.target}.${callInfo.method}`,
              target: {
                sdk: callInfo.target,
                endpoint: callInfo.method
              },
              operation: {
                action: callInfo.method,
                async: node.parent?.type === 'AwaitExpression'
              },
              metadata: {
                line: node.loc?.start.line,
                library: callInfo.library
              }
            } as CASExitPoint);

            const edgeId = `${callerNode.id}_calls_external_${callInfo.target}_${callInfo.method}`;
            if (!edges.find(e => e.id === edgeId)) {
              edges.push(this.createEdge(
                edgeId,
                callerNode.id,
                exitPointId,
                'calls',
                'behavior',
                {
                  call_type: 'library_call',
                  library: callInfo.library || callInfo.target,
                  method: callInfo.method,
                  is_async: node.parent?.type === 'AwaitExpression',
                  line: node.loc?.start.line
                }
              ));
            }
          } else {
            let targetNode: CASNode | undefined;

            if (callInfo.callType === 'internal' && callInfo.method) {
              targetNode = nodes.find(n =>
                n.name === callInfo.method &&
                n.type === 'method' &&
                n.parent === callerNode.parent
              );
            } else if (callInfo.callType === 'external' && callInfo.target && callInfo.method) {
              const possibleTargets = nodes.filter(n =>
                n.name === callInfo.method &&
                (n.type === 'method' || n.type === 'function')
              );

              if (possibleTargets.length === 1) {
                targetNode = possibleTargets[0];
              } else if (possibleTargets.length > 1 && currentContext.containingClass) {
                const injectedDeps = edges.filter(e =>
                  e.source.includes(currentContext.containingClass!) &&
                  e.type === 'calls' &&
                  e.metadata?.attributes?.call_type === 'injection'
                );

                for (const dep of injectedDeps) {
                  const depClass = nodes.find(n => n.id === dep.target);
                  if (depClass) {
                    targetNode = possibleTargets.find(n => n.parent === depClass.id);
                    if (targetNode) break;
                  }
                }
              }
            } else if (callInfo.callType === 'function' && callInfo.method) {
              targetNode = nodes.find(n =>
                n.name === callInfo.method &&
                n.type === 'function'
              );
            }

            if (targetNode && targetNode.id !== callerNode.id) {
              const edgeId = `${callerNode.id}_calls_${targetNode.id}`;
              if (!edges.find(e => e.id === edgeId)) {
                edges.push(this.createEdge(
                  edgeId,
                  callerNode.id,
                  targetNode.id,
                  'calls',
                  'behavior',
                  {
                    call_type: callInfo.callType || 'unknown',
                    is_async: node.parent?.type === 'AwaitExpression',
                    is_callback: node.parent?.type === 'CallExpression',
                    line: node.loc?.start.line,
                    target_object: callInfo.target,
                    target_method: callInfo.method
                  }
                ));
              }
            }
          }
        }
      }

      if (!node || typeof node !== 'object') return;

      if (node.type === 'NewExpression' && node.callee?.type === 'Identifier') {
        const callerNode = currentContext.containingNode;
        const className = node.callee.name;

        if (callerNode) {
          const targetClass = nodes.find(n => n.name === className && n.type === 'class');
          if (targetClass) {
            const constructor = nodes.find(n =>
              n.name === 'constructor' &&
              n.type === 'method' &&
              n.parent === targetClass.id
            );

            const targetId = constructor?.id || targetClass.id;
            const edgeId = `${callerNode.id}_instantiates_${targetId}`;

            if (!edges.find(e => e.id === edgeId)) {
              edges.push(this.createEdge(
                edgeId,
                callerNode.id,
                targetId,
                'calls',
                'behavior',
                {
                  call_type: 'constructor',
                  class_name: className,
                  line: node.loc?.start.line
                }
              ));
            }
          }
        }
      }

      for (const key in node) {
        if (key === 'parent') continue; // Skip parent references to avoid circular recursion

        if (Array.isArray(node[key])) {
          node[key].forEach((child: any) => {
            if (child && typeof child === 'object') {
              child.parent = node;
              walk(child, currentContext);
            }
          });
        } else if (typeof node[key] === 'object' && node[key]) {
          node[key].parent = node;
          walk(node[key], currentContext);
        }
      }
    };

    walk(ast);
  }


  private extractTypeNameFromAnnotation(typeNode: any): string | null {
    if (!typeNode) return null;
    if (typeNode.type === 'TSTypeReference' && typeNode.typeName) {
      if (typeNode.typeName.type === 'Identifier') {
        return typeNode.typeName.name;
      }
    }
    if (typeNode.type === 'Identifier') {
      return typeNode.name;
    }
    return null;
  }

  private buildCategories(): Partial<CASCategories> {
    const categories: Partial<CASCategories> = {};

    categories['1'] = {
      'modules': {
        name: 'Modules',
        types: ['file', 'module'],
        description: 'Source files and modules',
        languages: ['typescript', 'javascript']
      }
    };

    categories['2'] = {
      'structures': {
        name: 'Structures',
        types: ['class', 'interface', 'type', 'enum'],
        description: 'Classes, interfaces, and type definitions',
        languages: ['typescript', 'javascript']
      },
      'functions': {
        name: 'Functions',
        types: ['function', 'arrow-function'],
        description: 'Standalone functions',
        languages: ['typescript', 'javascript']
      }
    };

    categories['3'] = {
      'methods': {
        name: 'Methods',
        types: ['method', 'constructor', 'getter', 'setter'],
        description: 'Class methods and accessors',
        languages: ['typescript', 'javascript']
      }
    };

    categories['4'] = {
      'data': {
        name: 'Data',
        types: ['variable', 'property', 'parameter'],
        description: 'Variables, properties, and parameters',
        languages: ['typescript', 'javascript']
      }
    };

    return categories;
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
      'ast-parsing',
      'function-analysis',
      'class-detection',
      'import-tracking',
      'variable-analysis',
      'typescript-support',
      'call-graph-building'
    ];
  }

  private createPerspectives(perspectives: CASPerspective[]): void {
    perspectives.push({
      id: 'typescript-structure',
      name: 'TypeScript/JavaScript Structure',
      description: 'File and module organization showing files, modules, and their exports/imports',
      analyzer_id: this.analyzerId,
      type: 'structure',
      connection_rules: {
        visible_node_types: ['file', 'module', 'class', 'interface', 'type', 'enum'],
        relevant_edge_types: ['contains', 'imports', 'exports'],
        node_connections: [
          {
            from_type: 'file',
            to_types: ['class', 'interface', 'function', 'variable'],
            edge_type: 'contains'
          },
          {
            from_type: 'file',
            to_types: ['import'],
            edge_type: 'imports'
          }
        ]
      },
      layout_hints: {
        style: 'hierarchical',
        direction: 'TB',
        group_by: 'category'
      },
      metadata: {
        primary_focus: 'modules'
      }
    });

    perspectives.push({
      id: 'typescript-dependencies',
      name: 'TypeScript/JavaScript Dependencies',
      description: 'Dependency graph showing imports, exports, and module relationships',
      analyzer_id: this.analyzerId,
      type: 'flow',
      connection_rules: {
        visible_node_types: ['file', 'module', 'import', 'export'],
        relevant_edge_types: ['imports', 'exports', 'depends_on'],
        node_connections: [
          {
            from_type: 'file',
            to_types: ['file'],
            edge_type: 'imports',
            conditions: { external: false }
          },
          {
            from_type: 'module',
            to_types: ['module'],
            edge_type: 'depends_on'
          }
        ]
      },
      layout_hints: {
        style: 'force',
        group_by: 'module'
      },
      metadata: {
        show_external: true,
        highlight_circular: true
      }
    });

    perspectives.push({
      id: 'typescript-inheritance',
      name: 'TypeScript/JavaScript Inheritance',
      description: 'Class hierarchy and interface implementations',
      analyzer_id: this.analyzerId,
      type: 'structure',
      connection_rules: {
        visible_node_types: ['class', 'interface', 'abstract-class'],
        relevant_edge_types: ['extends', 'implements'],
        node_connections: [
          {
            from_type: 'class',
            to_types: ['class', 'abstract-class'],
            edge_type: 'extends'
          },
          {
            from_type: 'class',
            to_types: ['interface'],
            edge_type: 'implements'
          }
        ]
      },
      layout_hints: {
        style: 'hierarchical',
        direction: 'BT'
      },
      metadata: {
        show_members: false,
        focus: 'inheritance'
      }
    });
  }

  private extractJSDoc(node: any, content: string, lines: string[]): CASDocumentation | undefined {
    if (!node.loc) return undefined;

    const startLine = node.loc.start.line;
    if (startLine <= 1) return undefined;

    const previousLine = lines[startLine - 2];
    if (!previousLine) return undefined;

    const trimmed = previousLine.trim();
    if (!trimmed.endsWith('*/')) return undefined;

    let jsdocStart = -1;
    for (let i = startLine - 2; i >= 0; i--) {
      if (lines[i].includes('/**')) {
        jsdocStart = i;
        break;
      }
    }

    if (jsdocStart === -1) return undefined;

    const jsdocLines = lines.slice(jsdocStart, startLine - 1);
    const rawDoc = jsdocLines.join('\n');

    return this.parseJSDoc(rawDoc, jsdocStart + 1, startLine - 1);
  }

  private parseJSDoc(raw: string, startLine: number, endLine: number): CASDocumentation {
    const doc: CASDocumentation = {
      type: 'jsdoc',
      raw,
      location: { start_line: startLine, end_line: endLine }
    };

    const cleanLines = raw
      .split('\n')
      .map(line => line.replace(/^\s*\*\s?/, '').trim())
      .filter(line => line && !line.startsWith('/**') && !line.startsWith('*/'));

    const descriptionLines: string[] = [];
    const params: any[] = [];
    const tags: any[] = [];
    let returns: any = undefined;
    const throws: any[] = [];
    const examples: any[] = [];

    let currentExample: string[] | null = null;

    for (const line of cleanLines) {
      if (line.startsWith('@')) {
        const match = line.match(/^@(\w+)\s*(.*)/);
        if (match) {
          const [, tag, value] = match;

          if (tag === 'param' || tag === 'parameter') {
            const paramMatch = value.match(/^(?:\{([^}]+)\})?\s*(\S+)\s*(?:-\s*)?(.*)/);
            if (paramMatch) {
              const [, type, name, description] = paramMatch;
              params.push({
                name: name.replace(/[\[\]]/g, ''),
                type: type || undefined,
                description: description || undefined,
                optional: name.includes('[') || name.includes('?')
              });
            }
          } else if (tag === 'returns' || tag === 'return') {
            const returnMatch = value.match(/^(?:\{([^}]+)\})?\s*(.*)/);
            if (returnMatch) {
              const [, type, description] = returnMatch;
              returns = { type: type || undefined, description: description || undefined };
            }
          } else if (tag === 'throws' || tag === 'throw') {
            const throwMatch = value.match(/^(?:\{([^}]+)\})?\s*(.*)/);
            if (throwMatch) {
              const [, type, description] = throwMatch;
              throws.push({ type: type || undefined, description: description || undefined });
            }
          } else if (tag === 'example') {
            if (currentExample) {
              examples.push({ code: currentExample.join('\n'), language: 'javascript' });
            }
            currentExample = value ? [value] : [];
          } else if (tag === 'deprecated' || tag === 'since' || tag === 'author' || tag === 'see' || tag === 'link') {
            tags.push({ tag, value, metadata: {} });
          }
        }
      } else if (currentExample) {
        currentExample.push(line);
      } else {
        descriptionLines.push(line);
      }
    }

    if (currentExample) {
      examples.push({ code: currentExample.join('\n'), language: 'javascript' });
    }

    if (descriptionLines.length > 0) {
      const fullDescription = descriptionLines.join(' ');
      const summaryEnd = fullDescription.indexOf('. ');
      if (summaryEnd > 0) {
        doc.summary = fullDescription.substring(0, summaryEnd + 1);
        doc.description = fullDescription;
      } else {
        doc.summary = fullDescription;
        doc.description = fullDescription;
      }
    }

    if (params.length > 0) doc.parameters = params;
    if (returns) doc.returns = returns;
    if (throws.length > 0) doc.throws = throws;
    if (examples.length > 0) doc.examples = examples;
    if (tags.length > 0) doc.tags = tags;

    return doc;
  }

  private extractNodeComments(node: any, content: string, lines: string[]): CASComment[] {
    const comments: CASComment[] = [];
    if (!node.loc) return comments;

    const startLine = node.loc.start.line;
    const endLine = node.loc.end.line;

    for (let i = startLine; i <= endLine && i <= lines.length; i++) {
      const line = lines[i - 1];
      if (!line) continue;

      const singleLineMatch = line.match(/\/\/(.*)$/);
      if (singleLineMatch) {
        const text = singleLineMatch[1].trim();
        const purpose = this.classifyCommentPurpose(text);
        comments.push({
          id: `comment_${++this.commentCounter}`,
          type: 'single-line',
          style: '//',
          text,
          purpose,
          location: {
            file: node.loc.source || '',
            line: i,
            relative_to: 'inline'
          },
          markers: this.extractCommentMarkers(text)
        });
      }

      const blockMatch = line.match(/\/\*([^*]|\*(?!\/))*\*\//);
      if (blockMatch) {
        const text = blockMatch[0].replace(/^\/\*\s*/, '').replace(/\s*\*\/$/, '').trim();
        if (!text.includes('/**')) {
          const purpose = this.classifyCommentPurpose(text);
          comments.push({
            id: `comment_${++this.commentCounter}`,
            type: 'block',
            style: '/* */',
            text,
            purpose,
            location: {
              file: node.loc.source || '',
              line: i,
              relative_to: 'inline'
            },
            markers: this.extractCommentMarkers(text)
          });
        }
      }
    }

    return comments;
  }

  private extractCommentsFromFile(content: string, filePath: string): CASComment[] {
    const comments: CASComment[] = [];
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      const singleLineMatch = line.match(/\/\/(.*)$/);
      if (singleLineMatch) {
        const text = singleLineMatch[1].trim();
        const purpose = this.classifyCommentPurpose(text);
        comments.push({
          id: `comment_${++this.commentCounter}`,
          type: 'single-line',
          style: '//',
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
    if (/^\s*\/\/.+\s*$/.test(text) && text.includes('//')) return 'disabled-code';
    if (text.length < 50 && /explains?|because|since|why/i.test(text)) return 'clarification';
    return 'explanation';
  }

  private extractTodosFromComments(comments: CASComment[], context: string): CASTodo[] {
    const todos: CASTodo[] = [];

    comments.forEach(comment => {
      if (comment.markers?.is_todo || comment.markers?.is_fixme || comment.markers?.is_hack) {
        const typeMatch = comment.text.match(/\b(TODO|FIXME|HACK|NOTE|WARNING|XXX|OPTIMIZE|REFACTOR)\b/i);
        const type = typeMatch ? typeMatch[0].toUpperCase() as CASTodo['type'] : 'TODO';

        const assigneeMatch = comment.text.match(/\b(?:TODO|FIXME|HACK)\s*\(([^)]+)\)/);
        const assignee = assigneeMatch ? assigneeMatch[1] : undefined;

        const priority = comment.markers?.is_important ? 'high' :
                        comment.markers?.is_fixme ? 'medium' : 'low';

        todos.push({
          id: `todo_${++this.todoCounter}`,
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

  private detectImplementationStatus(node: any, content: string): CASImplementationStatus | undefined {
    if (!node || !node.body) return undefined;

    const bodyStr = content.substring(node.body.range?.[0] || 0, node.body.range?.[1] || 0);

    const statementCount = (bodyStr.match(/;/g) || []).length;
    const hasSubstantialCode = statementCount > 3 || bodyStr.length > 100;
    const simpleReturnPattern = /return\s+(null|undefined|false|0|''|""|\[\]|\{\})\s*;?\s*$/m;
    const isOnlySimpleReturn = simpleReturnPattern.test(bodyStr) && !hasSubstantialCode;

    const indicators = {
      has_todo_markers: /\b(TODO|FIXME|HACK)\b/i.test(bodyStr),
      has_not_implemented_exceptions: /throw\s+.*(NotImplemented|Unsupported|TODO)/i.test(bodyStr),
      has_stub_returns: isOnlySimpleReturn,
      has_placeholder_code: /console\.(log|warn|error)\s*\(['"].*TODO/i.test(bodyStr),
      has_hardcoded_values: /const\s+\w+\s*=\s*['"]PLACEHOLDER|TEMP|TODO/i.test(bodyStr),
      has_commented_out_code: /\/\/.*\w+\s*\(|^\/\*[\s\S]*?\*\//m.test(bodyStr)
    };

    const isEmptyBody = bodyStr.trim().match(/^\{\s*\}$/);
    const params = node.params || node.value?.params || [];
    const hasParameterProperties = params.some((p: any) =>
      p.type === 'TSParameterProperty' ||
      p.accessibility ||
      p.readonly
    );

    const hasImplementation = (bodyStr.trim().length > 10 && !isEmptyBody) ||
                              hasParameterProperties;

    let status: CASImplementationStatus['status'] = 'complete';
    if (!hasImplementation && !hasParameterProperties) {
      status = 'stub';
    } else if (indicators.has_not_implemented_exceptions) {
      status = 'not-implemented';
    } else if (indicators.has_todo_markers || indicators.has_stub_returns) {
      status = 'partial';
    }

    const deprecatedMatch = bodyStr.match(/@deprecated/i);
    if (deprecatedMatch) {
      status = 'deprecated';
    }

    const experimentalMatch = bodyStr.match(/@experimental|@beta/i);
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

  private extractParameters(params: any[], jsdoc?: CASDocumentation): any[] {
    return params.map((param: any) => {
      const name = param.name || param.left?.name || 'param';
      const jsdocParam = jsdoc?.parameters?.find(p => p.name === name);

      return {
        name,
        type: this.extractTypeFromAnnotation(param.typeAnnotation) || jsdocParam?.type,
        optional: param.optional || !!param.left,
        description: jsdocParam?.description,
        default_value: param.right ? this.extractLiteralValue(param.right) : undefined
      };
    });
  }

  private extractReturnType(returnTypeNode: any, jsdoc?: CASDocumentation): string | undefined {
    const annotationType = this.extractTypeFromAnnotation(returnTypeNode);
    return annotationType || jsdoc?.returns?.type;
  }

  private extractTypeFromAnnotation(typeNode: any): string | undefined {
    if (!typeNode) return undefined;
    if (typeNode.typeAnnotation) {
      typeNode = typeNode.typeAnnotation;
    }

    switch (typeNode.type) {
      case 'TSStringKeyword': return 'string';
      case 'TSNumberKeyword': return 'number';
      case 'TSBooleanKeyword': return 'boolean';
      case 'TSAnyKeyword': return 'any';
      case 'TSVoidKeyword': return 'void';
      case 'TSNullKeyword': return 'null';
      case 'TSUndefinedKeyword': return 'undefined';
      case 'TSArrayType':
        const elementType = this.extractTypeFromAnnotation(typeNode.elementType);
        return elementType ? `${elementType}[]` : 'Array';
      case 'TSTypeReference':
        if (typeNode.typeName?.type === 'Identifier') {
          return typeNode.typeName.name;
        }
        break;
    }
    return undefined;
  }

  private extractLiteralValue(node: any): any {
    if (!node) return undefined;

    switch (node.type) {
      case 'Literal': return node.value;
      case 'TemplateLiteral': return node.quasis.map((q: any) => q.value.raw).join('');
      case 'Identifier': return node.name;
      case 'ArrayExpression': return '[]';
      case 'ObjectExpression': return '{}';
      case 'ArrowFunctionExpression':
        if (node.body?.type === 'Identifier') {
          return `() => ${node.body.name}`;
        }
        if (node.body?.type === 'MemberExpression' && node.body.object?.type === 'Identifier') {
          return `() => ${node.body.object.name}.${node.body.property?.name || 'unknown'}`;
        }
        return '() => ...';
      default: return undefined;
    }
  }

  private extractDecorators(node: any): Array<{ name: string; arguments?: any[] }> | undefined {
    if (!node.decorators || node.decorators.length === 0) return undefined;

    return node.decorators.map((decorator: any) => {
      if (decorator.expression?.type === 'CallExpression') {
        const name = decorator.expression.callee?.name || 'unknown';
        const args = decorator.expression.arguments?.map((arg: any) =>
          this.extractLiteralValue(arg)
        );
        return { name, arguments: args };
      } else if (decorator.expression?.type === 'Identifier') {
        return { name: decorator.expression.name };
      }
      return { name: 'unknown' };
    });
  }

  private tagNodesWithPerspectives(nodes: CASNode[], edges: CASEdge[]): void {
    nodes.forEach(node => {
      node.perspectives = [];

      if (!node || typeof node !== 'object') return;

      if (node.type === 'file' || node.type === 'module' ||
          node.type === 'class' || node.type === 'interface' ||
          node.type === 'type' || node.type === 'enum') {
        node.perspectives.push('typescript-structure');
      }

      if (!node || typeof node !== 'object') return;

      if (node.type === 'file' || node.type === 'module' ||
          node.type === 'import' || node.type === 'export') {
        node.perspectives.push('typescript-dependencies');
      }

      if (!node || typeof node !== 'object') return;

      if (node.type === 'class' || node.type === 'interface' ||
          node.type === 'abstract-class') {
        node.perspectives.push('typescript-inheritance');
      }

      if (!node.metadata) {
        node.metadata = {};
      }
      node.metadata.perspective_data = {
        'typescript-structure': {
          module_path: node.source?.file,
          export_type: node.metadata?.is_exported ? 'exported' : 'internal'
        },
        'typescript-dependencies': {
          dependency_count: 0,
          dependent_count: 0
        },
        'typescript-inheritance': {
          hierarchy_level: 0,
          implements_count: 0,
          extends_from: null
        }
      };
    });

    edges.forEach(edge => {
      edge.perspectives = [];

      if (edge.type === 'contains' || edge.type === 'imports' || edge.type === 'exports') {
        edge.perspectives.push('typescript-structure');
      }

      if (edge.type === 'imports' || edge.type === 'exports' || edge.type === 'depends_on') {
        edge.perspectives.push('typescript-dependencies');
      }

      if (edge.type === 'extends' || edge.type === 'implements') {
        edge.perspectives.push('typescript-inheritance');
      }

      if (!edge.metadata) {
        edge.metadata = {};
      }
      edge.metadata.perspective_data = {
        'typescript-structure': {
          relationship_type: edge.type
        },
        'typescript-dependencies': {
          is_external: edge.metadata?.attributes?.external || false,
          is_circular: false
        },
        'typescript-inheritance': {
          inheritance_type: edge.type
        }
      };
    });
  }
}