import { BaseAnalyzer, AnalysisContext } from '../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, CASCategories, CASPerspective } from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
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

      this.buildCallGraph(nodes, edges);

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

    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;

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

    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;

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

    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;

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

  private buildCallGraph(nodes: CASNode[], edges: CASEdge[]): void {
    const classNodes = nodes.filter(n => n.type === 'class');
    const methodNodes = nodes.filter(n => n.type === 'method');
    const functionNodes = nodes.filter(n => n.type === 'function');

    for (const [filePath, parsedData] of this.astCache) {
      const ast = parsedData.ast;
      const content = parsedData.content;

      this.extractConstructorDependencyEdges(ast, filePath, nodes, edges);
      this.extractMethodCallEdges(ast, filePath, nodes, edges);
      this.extractFunctionCallEdges(ast, filePath, nodes, edges);
    }
  }

  private extractConstructorDependencyEdges(
    ast: TSESTree.Program,
    filePath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    const walk = (node: any) => {
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
        if (Array.isArray(node[key])) {
          node[key].forEach(walk);
        } else if (typeof node[key] === 'object') {
          walk(node[key]);
        }
      }
    };

    walk(ast);
  }

  private extractMethodCallEdges(
    ast: TSESTree.Program,
    filePath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    const walk = (node: any, currentClass?: string, currentMethod?: string) => {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'ClassDeclaration' && node.id) {
        const className = node.id.name;
        if (node.body?.body) {
          node.body.body.forEach((member: any) => {
            if (member.type === 'MethodDefinition' && member.key?.name) {
              walk(member.value, className, member.key.name);
            }
          });
        }
      }

      if (node.type === 'CallExpression' && currentClass && currentMethod) {
        const callerId = `method_class_${filePath}_${currentClass}_0_${currentMethod}_0`;
        const callerNode = nodes.find(n => n.id === callerId ||
          (n.name === currentMethod && n.type === 'method' && n.parent?.includes(currentClass)));

        if (!callerNode) return;

        let targetName: string | null = null;
        let targetMethod: string | null = null;
        let isThisCall = false;

        if (node.callee.type === 'MemberExpression') {
          // Handle this.serviceProperty.method() calls
          if (node.callee.object?.type === 'MemberExpression' &&
              node.callee.object.object?.type === 'ThisExpression') {
            targetName = node.callee.object.property?.name;
            targetMethod = node.callee.property?.name;
          }
          // Handle this.method() calls
          else if (node.callee.object?.type === 'ThisExpression') {
            targetMethod = node.callee.property?.name;
            targetName = currentClass; // Same class
            isThisCall = true;
          }
          // Handle serviceProperty.method() calls
          else if (node.callee.object?.type === 'Identifier') {
            targetName = node.callee.object.name;
            targetMethod = node.callee.property?.name;
          }
        }

        if (targetMethod) {
          let targetNode: CASNode | undefined;

          if (isThisCall) {
            // Find method in same class
            targetNode = nodes.find(n =>
              n.name === targetMethod &&
              n.type === 'method' &&
              n.parent === callerNode.parent
            );
          } else if (targetName) {
            // Find method in injected service
            // First, find what type was injected with this property name
            const classNode = nodes.find(n => n.id === callerNode.parent);
            if (classNode && classNode.metadata) {
              const deps = (classNode.metadata as any).attributes?.dependencies || [];
              // Look for a dependency that might match the property name
              const depType = deps.find((d: string) =>
                d.toLowerCase().includes(targetName.toLowerCase()) ||
                targetName.toLowerCase().includes(d.toLowerCase())
              );

              if (depType) {
                const depClassNode = nodes.find(n => n.name === depType);
                if (depClassNode) {
                  targetNode = nodes.find(n =>
                    n.name === targetMethod &&
                    n.type === 'method' &&
                    n.parent === depClassNode.id
                  );
                }
              }
            }

            // Fallback: try to find method by name pattern
            if (!targetNode) {
              targetNode = nodes.find(n =>
                n.name === targetMethod &&
                n.type === 'method'
              );
            }
          }

          if (targetNode && targetNode.id !== callerNode.id) {
            const edgeId = `${callerNode.id}_calls_${targetNode.id}_method`;
            if (!edges.find(e => e.id === edgeId)) {
              edges.push(this.createEdge(
                edgeId,
                callerNode.id,
                targetNode.id,
                'calls',
                'behavior',
                {
                  call_type: isThisCall ? 'internal_method_call' : 'method_invocation',
                  from_method: `${currentClass}.${currentMethod}`,
                  to_method: targetMethod,
                  via_property: !isThisCall ? targetName : undefined
                }
              ));
            }
          }
        }
      }

      for (const key in node) {
        if (key === 'body' || key === 'consequent' || key === 'alternate' ||
            key === 'expression' || key === 'argument' || key === 'arguments' ||
            key === 'init' || key === 'declarations' || key === 'elements') {
          if (Array.isArray(node[key])) {
            node[key].forEach((child: any) => walk(child, currentClass, currentMethod));
          } else if (typeof node[key] === 'object') {
            walk(node[key], currentClass, currentMethod);
          }
        }
      }
    };

    walk(ast);
  }

  private extractFunctionCallEdges(
    ast: TSESTree.Program,
    filePath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    const walk = (node: any, currentFunction?: string) => {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'FunctionDeclaration' && node.id) {
        walk(node.body, node.id.name);
      }

      if (node.type === 'CallExpression' && currentFunction) {
        const callerId = `function_${filePath}_${currentFunction}_0`;
        const callerNode = nodes.find(n => n.id === callerId);

        if (!callerNode) return;

        let targetName: string | null = null;

        if (node.callee.type === 'Identifier') {
          targetName = node.callee.name;
        }

        if (targetName) {
          const targetNode = nodes.find(n =>
            n.name === targetName &&
            n.type === 'function'
          );

          if (targetNode) {
            const edgeId = `${callerId}_calls_${targetNode.id}`;
            if (!edges.find(e => e.id === edgeId)) {
              edges.push(this.createEdge(
                edgeId,
                callerId,
                targetNode.id,
                'calls',
                'behavior',
                {
                  call_type: 'function_call',
                  from_function: currentFunction
                }
              ));
            }
          }
        }
      }

      for (const key in node) {
        if (Array.isArray(node[key])) {
          node[key].forEach((child: any) => walk(child, currentFunction));
        } else if (typeof node[key] === 'object') {
          walk(node[key], currentFunction);
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