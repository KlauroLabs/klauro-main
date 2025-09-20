import { TSESTree } from '@typescript-eslint/typescript-estree';
import * as path from 'path';

export interface ExtractedFunction {
  name: string;
  signature: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  columnStart: number;
  columnEnd: number;
  type: 'function' | 'method' | 'arrow' | 'constructor' | 'getter' | 'setter';
  isAsync: boolean;
  isGenerator: boolean;
  isExported: boolean;
  isStatic?: boolean;
  className?: string;
  parameters: Array<{
    name: string;
    type?: string;
    optional: boolean;
    defaultValue?: string;
  }>;
  returnType?: string;
  calls: ExtractedCall[];
  complexity: number;
  scope: ScopeInfo;
}

export interface ExtractedCall {
  target: string;
  targetType: 'function' | 'method' | 'constructor' | 'external' | 'unknown';
  line: number;
  column: number;
  argumentCount: number;
  isAsync: boolean;
  isConditional: boolean;
  isInLoop: boolean;
  callExpression: string;
  context: CallContext;
  resolvedTarget?: ResolvedTarget;
}

export interface CallContext {
  enclosingFunction: string;
  enclosingClass?: string;
  blockDepth: number;
  isInTry: boolean;
  isInCatch: boolean;
  isInFinally: boolean;
  isInCallback: boolean;
  isInPromise: boolean;
  conditionalDepth: number;
  loopDepth: number;
}

export interface ResolvedTarget {
  file?: string;
  componentId?: string;
  functionName: string;
  isExternal: boolean;
  isBuiltin: boolean;
  module?: string;
}

export interface ScopeInfo {
  type: 'global' | 'module' | 'class' | 'function' | 'block';
  parent?: string;
  variables: string[];
  imports: Map<string, ImportInfo>;
}

export interface ImportInfo {
  source: string;
  type: 'default' | 'named' | 'namespace';
  localName: string;
  importedName?: string;
}

export class EnhancedCallGraphExtractor {
  private functions: Map<string, ExtractedFunction> = new Map();
  private callGraph: Map<string, Set<string>> = new Map();
  private currentFile: string = '';
  private currentScope: ScopeInfo = {
    type: 'module',
    variables: [],
    imports: new Map()
  };
  private scopeStack: ScopeInfo[] = [];
  private contextStack: Partial<CallContext>[] = [];

  constructor(private projectPath: string) {}

  extractFromAST(ast: TSESTree.Program, filePath: string): {
    functions: ExtractedFunction[];
    callGraph: Map<string, string[]>;
  } {
    this.currentFile = path.relative(this.projectPath, filePath);
    this.functions.clear();
    this.callGraph.clear();
    this.scopeStack = [this.currentScope];

    // First pass: Extract imports and global scope
    this.extractImports(ast);

    // Second pass: Extract all functions
    this.extractFunctions(ast);

    // Third pass: Resolve call targets
    this.resolveCallTargets();

    return {
      functions: Array.from(this.functions.values()),
      callGraph: this.convertCallGraphToArray()
    };
  }

  private extractImports(ast: TSESTree.Program): void {
    for (const node of ast.body) {
      if (node.type === 'ImportDeclaration') {
        const source = node.source.value as string;

        for (const spec of node.specifiers) {
          if (spec.type === 'ImportDefaultSpecifier') {
            this.currentScope.imports.set(spec.local.name, {
              source,
              type: 'default',
              localName: spec.local.name
            });
          } else if (spec.type === 'ImportSpecifier') {
            const imported = spec.imported.type === 'Identifier' ? spec.imported.name : spec.local.name;
            this.currentScope.imports.set(spec.local.name, {
              source,
              type: 'named',
              localName: spec.local.name,
              importedName: imported
            });
          } else if (spec.type === 'ImportNamespaceSpecifier') {
            this.currentScope.imports.set(spec.local.name, {
              source,
              type: 'namespace',
              localName: spec.local.name
            });
          }
        }
      }
    }
  }

  private extractFunctions(node: any, parent?: any): void {
    // Extract function declarations
    if (node.type === 'FunctionDeclaration' && node.id) {
      this.extractFunctionNode(node, 'function', node.id.name, parent);
    }

    // Extract function expressions
    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      let name = 'anonymous';
      let type: ExtractedFunction['type'] = node.type === 'ArrowFunctionExpression' ? 'arrow' : 'function';

      // Try to get name from variable declaration
      if (parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier') {
        name = parent.id.name;
      }
      // Try to get name from property assignment
      else if (parent?.type === 'Property' && parent.key?.type === 'Identifier') {
        name = parent.key.name;
      }
      // Try to get name from assignment expression
      else if (parent?.type === 'AssignmentExpression' && parent.left?.type === 'Identifier') {
        name = parent.left.name;
      }

      this.extractFunctionNode(node, type, name, parent);
    }

    // Extract class methods
    if (node.type === 'MethodDefinition') {
      const methodName = node.key?.type === 'Identifier' ? node.key.name : 'method';
      const className = this.findEnclosingClass(parent);
      let type: ExtractedFunction['type'] = 'method';

      if (node.kind === 'constructor') type = 'constructor';
      else if (node.kind === 'get') type = 'getter';
      else if (node.kind === 'set') type = 'setter';

      this.extractFunctionNode(node.value, type, methodName, parent, className);
    }

    // Extract class properties that are functions
    if (node.type === 'PropertyDefinition' &&
        (node.value?.type === 'ArrowFunctionExpression' ||
         node.value?.type === 'FunctionExpression')) {
      const propertyName = node.key?.type === 'Identifier' ? node.key.name : 'property';
      const className = this.findEnclosingClass(parent);
      this.extractFunctionNode(node.value, 'arrow', propertyName, parent, className);
    }

    // Recursively traverse
    for (const key in node) {
      if (key !== 'parent' && node[key]) {
        if (Array.isArray(node[key])) {
          for (const child of node[key]) {
            if (child && typeof child === 'object') {
              this.extractFunctions(child, node);
            }
          }
        } else if (typeof node[key] === 'object') {
          this.extractFunctions(node[key], node);
        }
      }
    }
  }

  private extractFunctionNode(
    node: any,
    type: ExtractedFunction['type'],
    name: string,
    parent: any,
    className?: string
  ): void {
    const functionId = this.generateFunctionId(name, className);

    // Push new scope
    const newScope: ScopeInfo = {
      type: 'function',
      parent: functionId,
      variables: [],
      imports: new Map(this.currentScope.imports)
    };
    this.scopeStack.push(newScope);

    // Extract parameters
    const parameters = this.extractParameters(node.params || []);

    // Extract calls within this function
    const calls = this.extractCalls(node.body || node, functionId);

    // Calculate complexity
    const complexity = this.calculateComplexity(node);

    const extractedFunction: ExtractedFunction = {
      name,
      signature: this.generateSignature(name, parameters, node.returnType),
      file: this.currentFile,
      lineStart: node.loc?.start.line || 0,
      lineEnd: node.loc?.end.line || 0,
      columnStart: node.loc?.start.column || 0,
      columnEnd: node.loc?.end.column || 0,
      type,
      isAsync: node.async || false,
      isGenerator: node.generator || false,
      isExported: this.isExported(node, parent),
      isStatic: node.static || false,
      className,
      parameters,
      returnType: this.extractReturnType(node),
      calls,
      complexity,
      scope: newScope
    };

    this.functions.set(functionId, extractedFunction);

    // Pop scope
    this.scopeStack.pop();

    // Update call graph
    for (const call of calls) {
      if (!this.callGraph.has(functionId)) {
        this.callGraph.set(functionId, new Set());
      }
      this.callGraph.get(functionId)!.add(call.target);
    }
  }

  private extractCalls(node: any, enclosingFunction: string): ExtractedCall[] {
    const calls: ExtractedCall[] = [];
    const context: CallContext = {
      enclosingFunction,
      enclosingClass: this.findEnclosingClass(node),
      blockDepth: 0,
      isInTry: false,
      isInCatch: false,
      isInFinally: false,
      isInCallback: false,
      isInPromise: false,
      conditionalDepth: 0,
      loopDepth: 0
    };

    this.traverseForCalls(node, calls, context);
    return calls;
  }

  private traverseForCalls(node: any, calls: ExtractedCall[], context: CallContext): void {
    // Update context based on node type
    const updatedContext = { ...context };

    if (node.type === 'IfStatement' || node.type === 'ConditionalExpression') {
      updatedContext.conditionalDepth++;
    } else if (node.type === 'WhileStatement' || node.type === 'ForStatement' ||
               node.type === 'ForInStatement' || node.type === 'ForOfStatement' ||
               node.type === 'DoWhileStatement') {
      updatedContext.loopDepth++;
    } else if (node.type === 'TryStatement') {
      updatedContext.isInTry = true;
    } else if (node.type === 'CatchClause') {
      updatedContext.isInCatch = true;
      updatedContext.isInTry = false;
    } else if (node.type === 'BlockStatement' && node.parent?.type === 'TryStatement') {
      if (node === node.parent.finalizer) {
        updatedContext.isInFinally = true;
        updatedContext.isInTry = false;
        updatedContext.isInCatch = false;
      }
    }

    // Extract call expressions
    if (node.type === 'CallExpression') {
      const call = this.extractCallExpression(node, updatedContext);
      if (call) {
        calls.push(call);
      }
    }

    // Handle new expressions (constructor calls)
    if (node.type === 'NewExpression') {
      const call = this.extractNewExpression(node, updatedContext);
      if (call) {
        calls.push(call);
      }
    }

    // Handle dynamic imports
    if (node.type === 'ImportExpression') {
      calls.push({
        target: 'import',
        targetType: 'external',
        line: node.loc?.start.line || 0,
        column: node.loc?.start.column || 0,
        argumentCount: 1,
        isAsync: true,
        isConditional: updatedContext.conditionalDepth > 0,
        isInLoop: updatedContext.loopDepth > 0,
        callExpression: 'import()',
        context: updatedContext
      });
    }

    // Recursively traverse
    for (const key in node) {
      if (key !== 'parent' && node[key]) {
        if (Array.isArray(node[key])) {
          for (const child of node[key]) {
            if (child && typeof child === 'object') {
              this.traverseForCalls(child, calls, updatedContext);
            }
          }
        } else if (typeof node[key] === 'object') {
          this.traverseForCalls(node[key], calls, updatedContext);
        }
      }
    }
  }

  private extractCallExpression(node: any, context: CallContext): ExtractedCall | null {
    let target = 'unknown';
    let targetType: ExtractedCall['targetType'] = 'unknown';

    // Direct function call
    if (node.callee?.type === 'Identifier') {
      target = node.callee.name;
      targetType = 'function';
    }
    // Method call
    else if (node.callee?.type === 'MemberExpression') {
      if (node.callee.property?.type === 'Identifier') {
        target = node.callee.property.name;
        targetType = 'method';

        // Try to get the object name for better context
        if (node.callee.object?.type === 'Identifier') {
          target = `${node.callee.object.name}.${target}`;
        } else if (node.callee.object?.type === 'ThisExpression') {
          target = `this.${target}`;
        }
      }
    }
    // Super call
    else if (node.callee?.type === 'Super') {
      target = 'super';
      targetType = 'constructor';
    }

    // Check if it's a promise-related call
    const isInPromise = target.includes('then') || target.includes('catch') ||
                       target.includes('finally') || context.isInPromise;

    return {
      target,
      targetType,
      line: node.loc?.start.line || 0,
      column: node.loc?.start.column || 0,
      argumentCount: node.arguments?.length || 0,
      isAsync: node.callee?.type === 'AwaitExpression' || isInPromise,
      isConditional: context.conditionalDepth > 0,
      isInLoop: context.loopDepth > 0,
      callExpression: this.getCallExpressionString(node),
      context
    };
  }

  private extractNewExpression(node: any, context: CallContext): ExtractedCall | null {
    let target = 'unknown';

    if (node.callee?.type === 'Identifier') {
      target = `new ${node.callee.name}`;
    } else if (node.callee?.type === 'MemberExpression' && node.callee.property?.type === 'Identifier') {
      target = `new ${node.callee.property.name}`;
    }

    return {
      target,
      targetType: 'constructor',
      line: node.loc?.start.line || 0,
      column: node.loc?.start.column || 0,
      argumentCount: node.arguments?.length || 0,
      isAsync: false,
      isConditional: context.conditionalDepth > 0,
      isInLoop: context.loopDepth > 0,
      callExpression: this.getCallExpressionString(node),
      context
    };
  }

  private extractParameters(params: any[]): ExtractedFunction['parameters'] {
    return params.map(param => {
      let name = 'param';
      let optional = false;
      let defaultValue: string | undefined;

      if (param.type === 'Identifier') {
        name = param.name;
        optional = param.optional || false;
      } else if (param.type === 'AssignmentPattern') {
        if (param.left?.type === 'Identifier') {
          name = param.left.name;
        }
        optional = true;
        defaultValue = 'default';
      } else if (param.type === 'RestElement' && param.argument?.type === 'Identifier') {
        name = `...${param.argument.name}`;
      } else if (param.type === 'ObjectPattern') {
        name = '{object}';
      } else if (param.type === 'ArrayPattern') {
        name = '[array]';
      }

      return {
        name,
        type: param.typeAnnotation ? this.extractTypeAnnotation(param.typeAnnotation) : undefined,
        optional,
        defaultValue
      };
    });
  }

  private extractReturnType(node: any): string | undefined {
    if (node.returnType) {
      return this.extractTypeAnnotation(node.returnType);
    }
    return undefined;
  }

  private extractTypeAnnotation(typeAnnotation: any): string {
    if (!typeAnnotation || !typeAnnotation.typeAnnotation) return 'any';

    const type = typeAnnotation.typeAnnotation;

    switch (type.type) {
      case 'TSStringKeyword': return 'string';
      case 'TSNumberKeyword': return 'number';
      case 'TSBooleanKeyword': return 'boolean';
      case 'TSAnyKeyword': return 'any';
      case 'TSVoidKeyword': return 'void';
      case 'TSNullKeyword': return 'null';
      case 'TSUndefinedKeyword': return 'undefined';
      case 'TSUnknownKeyword': return 'unknown';
      case 'TSNeverKeyword': return 'never';
      case 'TSArrayType': return `${this.extractTypeAnnotation({ typeAnnotation: type.elementType })}[]`;
      case 'TSTypeReference':
        if (type.typeName?.type === 'Identifier') {
          return type.typeName.name;
        }
        return 'object';
      default:
        return 'any';
    }
  }

  private calculateComplexity(node: any): number {
    let complexity = 1;

    const traverse = (n: any) => {
      switch (n.type) {
        case 'IfStatement':
        case 'ConditionalExpression':
        case 'SwitchCase':
        case 'WhileStatement':
        case 'DoWhileStatement':
        case 'ForStatement':
        case 'ForInStatement':
        case 'ForOfStatement':
        case 'CatchClause':
          complexity++;
          break;
        case 'LogicalExpression':
          if (n.operator === '&&' || n.operator === '||' || n.operator === '??') {
            complexity++;
          }
          break;
      }

      for (const key in n) {
        if (key !== 'parent' && n[key]) {
          if (Array.isArray(n[key])) {
            for (const child of n[key]) {
              if (child && typeof child === 'object') {
                traverse(child);
              }
            }
          } else if (typeof n[key] === 'object') {
            traverse(n[key]);
          }
        }
      }
    };

    traverse(node);
    return complexity;
  }

  private resolveCallTargets(): void {
    // This would resolve imported functions, external modules, etc.
    // For now, we'll mark unresolved targets
    for (const func of this.functions.values()) {
      for (const call of func.calls) {
        call.resolvedTarget = this.resolveTarget(call.target, func.scope);
      }
    }
  }

  private resolveTarget(target: string, scope: ScopeInfo): ResolvedTarget {
    // Check if it's an imported function
    const importName = target.split('.')[0];
    if (scope.imports.has(importName)) {
      const importInfo = scope.imports.get(importName)!;
      return {
        functionName: target,
        isExternal: true,
        isBuiltin: false,
        module: importInfo.source
      };
    }

    // Check if it's a local function
    const localFunc = this.functions.get(target) ||
                     this.functions.get(`${this.currentFile}::${target}`);
    if (localFunc) {
      return {
        file: localFunc.file,
        functionName: localFunc.name,
        isExternal: false,
        isBuiltin: false
      };
    }

    // Check if it's a built-in
    const builtins = ['console', 'Math', 'Date', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Promise'];
    const isBuiltin = builtins.some(b => target.startsWith(b));

    return {
      functionName: target,
      isExternal: !isBuiltin,
      isBuiltin
    };
  }

  private generateFunctionId(name: string, className?: string): string {
    const parts = [this.currentFile];
    if (className) parts.push(className);
    parts.push(name);
    return parts.join('::');
  }

  private generateSignature(name: string, parameters: any[], returnType?: any): string {
    const params = parameters.map(p => p.name).join(', ');
    const ret = returnType ? `: ${returnType}` : '';
    return `${name}(${params})${ret}`;
  }

  private findEnclosingClass(node: any): string | undefined {
    let current = node;
    while (current) {
      if (current.type === 'ClassDeclaration' && current.id) {
        return current.id.name;
      }
      current = current.parent;
    }
    return undefined;
  }

  private isExported(node: any, parent: any): boolean {
    // Check for export keyword
    if (parent?.type === 'ExportNamedDeclaration' || parent?.type === 'ExportDefaultDeclaration') {
      return true;
    }

    // Check for module.exports or exports assignment
    if (parent?.type === 'AssignmentExpression') {
      const left = parent.left;
      if (left?.type === 'MemberExpression') {
        if (left.object?.name === 'module' && left.property?.name === 'exports') {
          return true;
        }
        if (left.object?.name === 'exports') {
          return true;
        }
      }
    }

    return false;
  }

  private getCallExpressionString(node: any): string {
    // Simplified - in production, you'd want to reconstruct the actual expression
    if (node.callee?.type === 'Identifier') {
      return `${node.callee.name}()`;
    } else if (node.callee?.type === 'MemberExpression') {
      const obj = node.callee.object?.type === 'Identifier' ? node.callee.object.name : 'object';
      const prop = node.callee.property?.type === 'Identifier' ? node.callee.property.name : 'property';
      return `${obj}.${prop}()`;
    }
    return 'call()';
  }

  private convertCallGraphToArray(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const [caller, targets] of this.callGraph) {
      result.set(caller, Array.from(targets));
    }
    return result;
  }

  // Build complete call chains
  buildCallChains(): Array<{
    id: string;
    type: 'entry-to-exit' | 'circular' | 'recursive' | 'dead-end' | 'hot-path';
    path: string[];
    depth: number;
    hasCircularDependency: boolean;
  }> {
    const chains: any[] = [];
    const visited = new Set<string>();
    const entryPoints = this.findEntryPoints();

    for (const entry of entryPoints) {
      const path: string[] = [];
      this.traverseCallChain(entry, path, visited, chains, 0);
    }

    return chains;
  }

  private findEntryPoints(): string[] {
    const entryPoints: string[] = [];

    for (const [funcId, func] of this.functions) {
      // Exported functions are entry points
      if (func.isExported) {
        entryPoints.push(funcId);
      }

      // Main/index functions are entry points
      if (func.name === 'main' || func.name === 'index' || func.name === 'start') {
        entryPoints.push(funcId);
      }

      // Event handlers are entry points
      if (func.name.startsWith('on') || func.name.startsWith('handle')) {
        entryPoints.push(funcId);
      }

      // Route handlers are entry points
      if (func.file.includes('routes') || func.file.includes('controllers')) {
        entryPoints.push(funcId);
      }
    }

    // If no entry points found, consider all exported functions
    if (entryPoints.length === 0) {
      for (const [funcId, func] of this.functions) {
        if (func.isExported) {
          entryPoints.push(funcId);
        }
      }
    }

    return entryPoints;
  }

  private traverseCallChain(
    funcId: string,
    path: string[],
    visited: Set<string>,
    chains: any[],
    depth: number
  ): void {
    // Check for circular dependency
    if (path.includes(funcId)) {
      chains.push({
        id: `circular_${funcId}_${Date.now()}`,
        type: 'circular',
        path: [...path, funcId],
        depth,
        hasCircularDependency: true
      });
      return;
    }

    // Check max depth
    if (depth > 50) {
      chains.push({
        id: `deep_${funcId}_${Date.now()}`,
        type: 'dead-end',
        path: [...path, funcId],
        depth,
        hasCircularDependency: false
      });
      return;
    }

    path.push(funcId);
    visited.add(funcId);

    const targets = this.callGraph.get(funcId) || [];

    if (Array.isArray(targets) ? targets.length === 0 : targets.size === 0) {
      // Dead end - no further calls
      chains.push({
        id: `deadend_${funcId}_${Date.now()}`,
        type: 'dead-end',
        path: [...path],
        depth,
        hasCircularDependency: false
      });
    } else {
      for (const target of targets) {
        this.traverseCallChain(target, [...path], visited, chains, depth + 1);
      }
    }
  }
}