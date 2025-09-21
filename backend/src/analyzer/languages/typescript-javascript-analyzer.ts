import { BaseAnalyzer, AnalysisContext } from '../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, CASCategories, CASPerspective } from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import { EnhancedCallGraphExtractor } from '../enhanced-call-graph-extractor';
import * as path from 'path';
import * as fs from 'fs-extra';
import { parse, TSESTree } from '@typescript-eslint/typescript-estree';
import { glob } from 'glob';

interface ParsedAST {
  ast: TSESTree.Program;
  content: string;
  filePath: string;
}

interface FunctionInfo {
  name: string;
  type: 'function' | 'method' | 'arrow' | 'async' | 'constructor';
  parameters: Array<{ name: string; type?: string; optional: boolean }>;
  returnType?: string;
  lineStart: number;
  lineEnd: number;
  isExported: boolean;
  isAsync: boolean;
}

interface ClassInfo {
  name: string;
  extends?: string;
  implements: string[];
  methods: FunctionInfo[];
  properties: Array<{ name: string; type?: string; isStatic: boolean; isPrivate: boolean }>;
  lineStart: number;
  lineEnd: number;
  isExported: boolean;
  isAbstract: boolean;
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
        useJSXTextNode: true,
        ecmaFeatures: { jsx: true },
        sourceType: 'module'
      });

      this.astCache.set(relativePath, { ast, content, filePath: fullPath });

      const fileId = `file_${relativePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
      nodes.push(this.createNode(
        fileId,
        path.basename(relativePath),
        'file',
        1,
        fullPath,
        1,
        content.split('\n').length,
        {
          relativePath,
          extension: path.extname(relativePath),
          isTypeScript: relativePath.endsWith('.ts') || relativePath.endsWith('.tsx')
        }
      ));

      this.extractImports(ast, relativePath, nodes, edges, exitPoints);
      this.extractFunctions(ast, relativePath, nodes, edges, entryPoints);
      this.extractClasses(ast, relativePath, nodes, edges);
      this.extractVariables(ast, relativePath, nodes);
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
      if (node.type === 'ImportDeclaration' && node.source.type === 'Literal') {
        const importSource = node.source.value as string;
        const importId = `import_${filePath}_${index}`;

        nodes.push(this.createNode(
          importId,
          `import ${importSource}`,
          'import',
          3,
          filePath,
          node.loc?.start.line,
          node.loc?.end.line,
          { source: importSource, specifiers: this.getImportSpecifiers(node) }
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
    entryPoints: any[]
  ): void {
    const functions = this.findFunctionsInAST(ast);
    const fileId = `file_${filePath.replace(/[^a-zA-Z0-9]/g, '_')}`;

    functions.forEach((func, index) => {
      const funcId = `function_${filePath}_${func.name}_${index}`;

      nodes.push(this.createNodeBuilder(
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
          attributes: {
            functionType: func.type
          }
        })
        .withSignature({
          parameters: func.parameters,
          return_type: func.returnType
        })
        .build());

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
    edges: CASEdge[]
  ): void {
    const classes = this.findClassesInAST(ast);
    const fileId = `file_${filePath.replace(/[^a-zA-Z0-9]/g, '_')}`;

    classes.forEach((cls, index) => {
      const classId = `class_${filePath}_${cls.name}_${index}`;

      nodes.push(this.createNodeBuilder(
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
            propertyCount: cls.properties.length
          }
        })
        .build());

      edges.push(this.createEdge(
        `${fileId}_contains_${classId}`,
        fileId,
        classId,
        'contains'
      ));

      cls.methods.forEach((method, methodIndex) => {
        const methodId = `method_${classId}_${method.name}_${methodIndex}`;

        nodes.push(this.createNodeBuilder(
          methodId,
          method.name,
          'method'
        )
          .withLevel(3, 'Method/Function')
          .withCategory('methods', ['class-methods'])
          .withSource({ file: filePath, line: method.lineStart, end_line: method.lineEnd })
          .withMetadata({
            is_async: method.isAsync,
            attributes: {
              methodType: method.type
            }
          })
          .withSignature({
            parameters: method.parameters,
            return_type: method.returnType
          })
          .withParent(classId)
          .build());

        edges.push(this.createEdge(
          `${classId}_contains_${methodId}`,
          classId,
          methodId,
          'contains'
        ));
      });
    });
  }

  private extractVariables(ast: TSESTree.Program, filePath: string, nodes: CASNode[]): void {
    const variables = this.findVariablesInAST(ast);
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

  private findFunctionsInAST(ast: TSESTree.Program): FunctionInfo[] {
    const functions: FunctionInfo[] = [];
    const visited = new WeakSet();

    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (visited.has(node)) return;
      visited.add(node);

      if (node.type === 'FunctionDeclaration' && node.id) {
        functions.push({
          name: node.id.name,
          type: node.async ? 'async' : 'function',
          parameters: node.params.map((p: any) => ({
            name: p.name || 'param',
            type: undefined,
            optional: p.optional || false
          })),
          lineStart: node.loc?.start.line || 0,
          lineEnd: node.loc?.end.line || 0,
          isExported: false,
          isAsync: node.async || false
        });
      }

      if (node.type === 'MethodDefinition') {
        functions.push({
          name: node.key.name || 'method',
          type: node.kind === 'constructor' ? 'constructor' : 'method',
          parameters: node.value.params.map((p: any) => ({
            name: p.name || 'param',
            type: undefined,
            optional: p.optional || false
          })),
          lineStart: node.loc?.start.line || 0,
          lineEnd: node.loc?.end.line || 0,
          isExported: false,
          isAsync: node.value.async || false
        });
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
    return functions;
  }

  private findClassesInAST(ast: TSESTree.Program): ClassInfo[] {
    const classes: ClassInfo[] = [];
    const visited = new WeakSet();

    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (visited.has(node)) return;
      visited.add(node);

      if (node.type === 'ClassDeclaration' && node.id) {
        const methods = node.body.body
          .filter((member: any) => member.type === 'MethodDefinition')
          .map((method: any) => ({
            name: method.key.name || 'method',
            type: method.kind === 'constructor' ? 'constructor' : 'method',
            parameters: method.value.params.map((p: any) => ({
              name: p.name || 'param',
              type: undefined,
              optional: p.optional || false
            })),
            lineStart: method.loc?.start.line || 0,
            lineEnd: method.loc?.end.line || 0,
            isExported: false,
            isAsync: method.value.async || false
          }));

        const properties = node.body.body
          .filter((member: any) => member.type === 'PropertyDefinition')
          .map((prop: any) => ({
            name: prop.key.name || 'property',
            type: undefined,
            isStatic: prop.static || false,
            isPrivate: prop.accessibility === 'private'
          }));

        classes.push({
          name: node.id.name,
          extends: node.superClass?.name,
          implements: node.implements?.map((impl: any) => impl.expression?.name || 'unknown') || [],
          methods,
          properties,
          lineStart: node.loc?.start.line || 0,
          lineEnd: node.loc?.end.line || 0,
          isExported: false,
          isAbstract: node.abstract || false
        });
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
    return classes;
  }

  private findVariablesInAST(ast: TSESTree.Program): VariableInfo[] {
    const variables: VariableInfo[] = [];
    const visited = new WeakSet();

    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (visited.has(node)) return;
      visited.add(node);

      if (node.type === 'VariableDeclaration') {
        node.declarations.forEach((declaration: any) => {
          if (declaration.id && declaration.id.name) {
            variables.push({
              name: declaration.id.name,
              type: undefined,
              value: undefined,
              kind: node.kind,
              line: node.loc?.start.line || 0,
              isExported: false
            });
          }
        });
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
          entryPoints.push({
            id: `http_${func.name}_${call.httpMethod}`,
            source_node: `function_${filePath}_${func.name}_0`,
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

        // Library calls as exit points
        if (call.targetType === 'library' && call.library) {
          exitPoints.push({
            id: `exit_${func.name}_${call.target}`,
            source_node: `function_${filePath}_${func.name}_0`,
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

        // Abstract method calls
        if (call.targetType === 'abstract') {
          const sourceNodeId = `function_${filePath}_${func.name}_0`;
          const targetNodeId = this.findNodeIdByName(call.target, nodes);

          if (targetNodeId) {
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
          const sourceNodeId = `function_${filePath}_${func.name}_0`;
          const targetNodeId = this.findNodeIdByName(call.target, nodes);

          if (targetNodeId) {
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
          const sourceNodeId = `function_${filePath}_${func.name}_0`;
          const targetNodeId = this.findNodeIdByName(call.target, nodes);

          if (targetNodeId && sourceNodeId !== targetNodeId) {
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
          }
        }
      });
    });
  }

  private findNodeIdByName(targetName: string, nodes: CASNode[]): string | undefined {
    // Try exact match first
    let targetNode = nodes.find(n => n.name === targetName);

    // Try method name from object.method format
    if (!targetNode && targetName.includes('.')) {
      const methodName = targetName.split('.').pop();
      targetNode = nodes.find(n => n.name === methodName && n.type === 'method');
    }

    // Try function name
    if (!targetNode) {
      targetNode = nodes.find(n => n.name === targetName && (n.type === 'function' || n.type === 'method'));
    }

    return targetNode?.id;
  }

  private validateCallGraph(nodes: CASNode[], edges: CASEdge[]): void {
    // Validate that all edge sources and targets exist as nodes
    const nodeIds = new Set(nodes.map(n => n.id));

    edges.forEach((edge, index) => {
      if (!nodeIds.has(edge.source) && !edge.source.startsWith('exit_') && !edge.source.startsWith('library_')) {
        console.warn(`Edge ${edge.id} has invalid source: ${edge.source}`);
      }
      if (!nodeIds.has(edge.target) && !edge.target.startsWith('exit_') && !edge.target.startsWith('library_')) {
        console.warn(`Edge ${edge.id} has invalid target: ${edge.target}`);
      }
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
                  const edgeId = `${classId}_calls_${depNode.id}_injection_${index}`;
                  if (!edges.find(e => e.id === edgeId)) {
                    edges.push(this.createEdge(
                      edgeId,
                      classId,
                      depNode.id,
                      'calls',
                      'dependency',
                      {
                        call_type: 'injection',
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
              if (propType) {
                const depNode = nodes.find(n =>
                  n.name === propType &&
                  (n.type === 'class' || n.type === 'service' || n.type === 'repository')
                );

                if (depNode && member.decorators?.some((d: any) => d.expression?.callee?.name === 'Inject')) {
                  const edgeId = `${classId}_calls_${depNode.id}_prop_injection`;
                  if (!edges.find(e => e.id === edgeId)) {
                    edges.push(this.createEdge(
                      edgeId,
                      classId,
                      depNode.id,
                      'calls',
                      'dependency',
                      {
                        call_type: 'property_injection',
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

    const extractCallInfo = (node: any): {target?: string, method?: string, isLibrary?: boolean, callType?: string} => {
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

        const isLibrary = commonLibraries.some(lib => objectName?.startsWith(lib));

        return {
          target: objectName || undefined,
          method: methodName,
          isLibrary,
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

      if (node.type === 'CallExpression') {
        const callInfo = extractCallInfo(node);
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
                line: node.loc?.start.line
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
                  library: callInfo.target,
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

  private tagNodesWithPerspectives(nodes: CASNode[], edges: CASEdge[]): void {
    nodes.forEach(node => {
      node.perspectives = [];

      if (node.type === 'file' || node.type === 'module' ||
          node.type === 'class' || node.type === 'interface' ||
          node.type === 'type' || node.type === 'enum') {
        node.perspectives.push('typescript-structure');
      }

      if (node.type === 'file' || node.type === 'module' ||
          node.type === 'import' || node.type === 'export') {
        node.perspectives.push('typescript-dependencies');
      }

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