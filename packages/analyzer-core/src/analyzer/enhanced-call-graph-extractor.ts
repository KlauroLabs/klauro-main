import { TSESTree } from '@typescript-eslint/typescript-estree';
import { CASNode, CASEdge, CASEntryPoint, CASExitPoint } from '../types/cas.types';
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
  targetType: 'function' | 'method' | 'constructor' | 'external' | 'unknown' | 'library' | 'abstract' | 'property';
  line: number;
  column: number;
  argumentCount: number;
  isAsync: boolean;
  isConditional: boolean;
  isInLoop: boolean;
  callExpression: string;
  context: CallContext;
  resolvedTarget?: ResolvedTarget;
  library?: string;
  decorators?: string[];
  httpMethod?: string;
  httpPath?: string;
  injectionType?: 'constructor' | 'property' | 'parameter';
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
  private currentClassName: string | undefined = undefined;

  constructor(private projectPath: string) {}

  extractFromAST(ast: TSESTree.Program, filePath: string): {
    functions: ExtractedFunction[];
    callGraph: Map<string, string[]>;
  } {
    this.currentFile = path.relative(this.projectPath, filePath);
    this.functions.clear();
    this.callGraph.clear();
    this.scopeStack = [this.currentScope];


    this.extractImports(ast);


    this.extractFunctions(ast);


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
    const previousClassName = this.currentClassName;

    if (node.type === 'ClassDeclaration' && node.id) {
      this.currentClassName = node.id.name;
    }







    if (node.type === 'FunctionDeclaration' && node.id) {
      this.extractFunctionNode(node, 'function', node.id.name, parent);
    }


    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      let name = 'anonymous';
      let type: ExtractedFunction['type'] = node.type === 'ArrowFunctionExpression' ? 'arrow' : 'function';


      if (parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier') {
        name = parent.id.name;
      }

      else if (parent?.type === 'Property' && parent.key?.type === 'Identifier') {
        name = parent.key.name;
      }

      else if (parent?.type === 'AssignmentExpression' && parent.left?.type === 'Identifier') {
        name = parent.left.name;
      }

      this.extractFunctionNode(node, type, name, parent);
    }


    if (node.type === 'MethodDefinition') {
      const methodName = node.key?.type === 'Identifier' ? node.key.name : 'method';
      let type: ExtractedFunction['type'] = 'method';

      if (node.kind === 'constructor') type = 'constructor';
      else if (node.kind === 'get') type = 'getter';
      else if (node.kind === 'set') type = 'setter';

      this.extractFunctionNode(node.value, type, methodName, parent, this.currentClassName);
    }


    if (node.type === 'PropertyDefinition' &&
        (node.value?.type === 'ArrowFunctionExpression' ||
         node.value?.type === 'FunctionExpression')) {
      const propertyName = node.key?.type === 'Identifier' ? node.key.name : 'property';
      this.extractFunctionNode(node.value, 'arrow', propertyName, parent, this.currentClassName);
    }


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

    this.currentClassName = previousClassName;
  }

  private extractFunctionNode(
    node: any,
    type: ExtractedFunction['type'],
    name: string,
    parent: any,
    className?: string
  ): void {
    const functionId = this.generateFunctionId(name, className);


    const newScope: ScopeInfo = {
      type: 'function',
      parent: functionId,
      variables: [],
      imports: new Map(this.currentScope.imports)
    };
    this.scopeStack.push(newScope);


    const parameters = this.extractParameters(node.params || []);


    const calls = this.extractCalls(node.body || node, functionId);


    if (node.type === 'MethodDefinition') {
      const httpEndpoints = this.extractHTTPEndpoints(node);
      const injections = this.extractDependencyInjection(parent);
      calls.push(...httpEndpoints, ...injections);
    }


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


    this.scopeStack.pop();


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

  private traverseForCalls(node: any, calls: ExtractedCall[], context: CallContext, parent: any = null): void {

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
    } else if (node.type === 'BlockStatement' && parent?.type === 'TryStatement') {
      if (node === parent.finalizer) {
        updatedContext.isInFinally = true;
        updatedContext.isInTry = false;
        updatedContext.isInCatch = false;
      }
    }


    if (node.type === 'CallExpression') {
      const call = this.extractCallExpression(node, updatedContext);
      if (call) {
        calls.push(call);
      }


      const libraryCalls = this.extractLibraryCalls(node, updatedContext);
      const abstractCalls = this.extractAbstractMethodCalls(node, updatedContext);
      calls.push(...libraryCalls, ...abstractCalls);
    }


    if (node.type === 'NewExpression') {
      const call = this.extractNewExpression(node, updatedContext);
      if (call) {
        calls.push(call);
      }
    }


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








    const referenceCall = this.extractIdentifierReference(node, parent, updatedContext);
    if (referenceCall) {
      calls.push(referenceCall);
    }


    for (const key in node) {
      if (key !== 'parent' && node[key]) {
        if (Array.isArray(node[key])) {
          for (const child of node[key]) {
            if (child && typeof child === 'object') {
              this.traverseForCalls(child, calls, updatedContext, node);
            }
          }
        } else if (typeof node[key] === 'object') {
          this.traverseForCalls(node[key], calls, updatedContext, node);
        }
      }
    }
  }

  private extractCallExpression(node: any, context: CallContext): ExtractedCall | null {
    let target = 'unknown';
    let targetType: ExtractedCall['targetType'] = 'unknown';


    if (node.callee?.type === 'Identifier') {
      target = node.callee.name;
      targetType = 'function';
    }

    else if (node.callee?.type === 'MemberExpression') {
      if (node.callee.property?.type === 'Identifier') {
        const methodName = node.callee.property.name;
        targetType = 'method';

        const objectName = this.getObjectName(node.callee.object);
        if (objectName) {
          target = `${objectName}.${methodName}`;
        } else {
          target = methodName;
        }
      }
    }

    else if (node.callee?.type === 'Super') {
      target = 'super';
      targetType = 'constructor';
    }


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





  private static readonly IDENTIFIER_BINDING_PARENTS = new Set([
    'VariableDeclarator',
    'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
    'ClassDeclaration', 'ClassExpression',
    'ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier',
    'ExportSpecifier',
    'TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSEnumDeclaration', 'TSEnumMember',
    'MethodDefinition', 'TSAbstractMethodDefinition',
    'Property',
    'PropertyDefinition', 'TSAbstractPropertyDefinition',
    'TSTypeReference', 'TSTypeAnnotation', 'TSQualifiedName',
    'LabeledStatement', 'BreakStatement', 'ContinueStatement',
  ]);











  private extractIdentifierReference(node: any, parent: any, context: CallContext): ExtractedCall | null {
    if (node.type !== 'Identifier') return null;
    const name = node.name;
    if (!name) return null;

    const imported = this.currentScope.imports.get(name);
    if (!imported) return null;

    if (!parent) return null;




    if ((parent.type === 'CallExpression' || parent.type === 'NewExpression') && parent.callee === node) {
      return null;
    }








    if (EnhancedCallGraphExtractor.IDENTIFIER_BINDING_PARENTS.has(parent.type)) {


      if (!(parent.type === 'VariableDeclarator' && parent.init === node)) {
        return null;
      }
    }

    return {
      target: name,
      targetType: 'property',
      line: node.loc?.start.line || 0,
      column: node.loc?.start.column || 0,
      argumentCount: 0,
      isAsync: false,
      isConditional: context.conditionalDepth > 0,
      isInLoop: context.loopDepth > 0,
      callExpression: name,
      context,


      resolvedTarget: { functionName: name, isExternal: false, isBuiltin: false }
    } as ExtractedCall & { referenceKind: 'identifier' };
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


    for (const func of this.functions.values()) {
      for (const call of func.calls) {
        call.resolvedTarget = this.resolveTarget(call.target, func.scope);
      }
    }
  }

  private resolveTarget(target: string, scope: ScopeInfo): ResolvedTarget {




    if (target.startsWith('this.') || target.startsWith('self.')) {
      const methodName = target.slice(target.indexOf('.') + 1);
      const localMethod = this.functions.get(methodName) ||
        this.functions.get(`${this.currentFile}::${methodName}`) ||
        [...this.functions.values()].find(f => f.name === methodName && f.file === this.currentFile);
      if (localMethod) {
        return { file: localMethod.file, functionName: localMethod.name, isExternal: false, isBuiltin: false };
      }
    }

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

    if (parent?.type === 'ExportNamedDeclaration' || parent?.type === 'ExportDefaultDeclaration') {
      return true;
    }


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

      if (func.isExported) {
        entryPoints.push(funcId);
      }


      if (func.name === 'main' || func.name === 'index' || func.name === 'start') {
        entryPoints.push(funcId);
      }


      if (func.name.startsWith('on') || func.name.startsWith('handle')) {
        entryPoints.push(funcId);
      }


      if (func.file.includes('routes') || func.file.includes('controllers')) {
        entryPoints.push(funcId);
      }
    }


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



  extractHTTPEndpoints(node: any): ExtractedCall[] {
    const httpEndpoints: ExtractedCall[] = [];

    if (node.type === 'MethodDefinition' && node.decorators) {
      const httpMethods = ['Get', 'Post', 'Put', 'Delete', 'Patch', 'Options', 'Head'];

      node.decorators.forEach((decorator: any) => {
        if (decorator.expression?.type === 'CallExpression' &&
            decorator.expression.callee?.type === 'Identifier') {
          const decoratorName = decorator.expression.callee.name;

          if (httpMethods.includes(decoratorName)) {
            const routePath = decorator.expression.arguments?.[0]?.value || '/';
            httpEndpoints.push({
              target: node.key?.name || 'handler',
              targetType: 'method',
              line: decorator.loc?.start.line || 0,
              column: decorator.loc?.start.column || 0,
              argumentCount: 0,
              isAsync: node.value?.async || false,
              isConditional: false,
              isInLoop: false,
              callExpression: `@${decoratorName}('${routePath}')`,
              context: this.createDefaultContext(node.key?.name || 'handler'),
              httpMethod: decoratorName.toUpperCase(),
              httpPath: routePath,
              decorators: [decoratorName]
            });
          }
        }
      });
    }

    return httpEndpoints;
  }

  extractLibraryCalls(node: any, context: CallContext): ExtractedCall[] {
    const libraryCalls: ExtractedCall[] = [];

    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression') {
      const objectName = this.getObjectName(node.callee.object);
      const methodName = node.callee.property?.name;

      if (objectName && methodName) {
        const libraryType = this.detectLibraryType(objectName);
        if (libraryType !== 'unknown') {
          libraryCalls.push({
            target: `${objectName}.${methodName}`,
            targetType: 'library',
            line: node.loc?.start.line || 0,
            column: node.loc?.start.column || 0,
            argumentCount: node.arguments?.length || 0,
            isAsync: node.parent?.type === 'AwaitExpression',
            isConditional: context.conditionalDepth > 0,
            isInLoop: context.loopDepth > 0,
            callExpression: `${objectName}.${methodName}()`,
            context,
            library: objectName
          });
        }
      }
    }

    return libraryCalls;
  }

  extractDependencyInjection(node: any): ExtractedCall[] {
    const injections: ExtractedCall[] = [];

    if (node.type === 'ClassDeclaration' && node.id) {
      const className = node.id.name;


      const constructor = node.body?.body?.find((member: any) =>
        member.type === 'MethodDefinition' && member.kind === 'constructor'
      );

      if (constructor?.value?.params) {
        constructor.value.params.forEach((param: any, index: number) => {
          if (param.typeAnnotation?.typeAnnotation) {
            const depType = this.extractTypeFromAnnotation(param.typeAnnotation.typeAnnotation);
            if (depType) {
              injections.push({
                target: depType,
                targetType: 'constructor',
                line: param.loc?.start.line || 0,
                column: param.loc?.start.column || 0,
                argumentCount: 0,
                isAsync: false,
                isConditional: false,
                isInLoop: false,
                callExpression: `constructor(${param.name || `param${index}`}: ${depType})`,
                context: this.createDefaultContext(className),
                injectionType: 'constructor'
              });
            }
          }
        });
      }


      if (node.body?.body) {
        node.body.body.forEach((member: any) => {
          if (member.type === 'PropertyDefinition' &&
              member.typeAnnotation?.typeAnnotation &&
              member.decorators?.some((d: any) => d.expression?.callee?.name === 'Inject')) {
            const propType = this.extractTypeFromAnnotation(member.typeAnnotation.typeAnnotation);
            if (propType) {
              injections.push({
                target: propType,
                targetType: 'property',
                line: member.loc?.start.line || 0,
                column: member.loc?.start.column || 0,
                argumentCount: 0,
                isAsync: false,
                isConditional: false,
                isInLoop: false,
                callExpression: `@Inject() ${member.key?.name}: ${propType}`,
                context: this.createDefaultContext(className),
                injectionType: 'property'
              });
            }
          }
        });
      }
    }

    return injections;
  }

  extractAbstractMethodCalls(node: any, context: CallContext): ExtractedCall[] {
    const abstractCalls: ExtractedCall[] = [];

    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression') {
      const objectName = this.getObjectName(node.callee.object);
      const methodName = node.callee.property?.name;


      const abstractMethods = ['canAnalyze', 'analyze', 'shouldUse', 'detect', 'process'];

      if (methodName && abstractMethods.includes(methodName)) {
        abstractCalls.push({
          target: `${objectName || 'unknown'}.${methodName}`,
          targetType: 'abstract',
          line: node.loc?.start.line || 0,
          column: node.loc?.start.column || 0,
          argumentCount: node.arguments?.length || 0,
          isAsync: node.parent?.type === 'AwaitExpression',
          isConditional: context.conditionalDepth > 0,
          isInLoop: context.loopDepth > 0,
          callExpression: `${objectName || 'unknown'}.${methodName}()`,
          context
        });
      }
    }

    return abstractCalls;
  }

  private getObjectName(node: any): string | null {
    if (node.type === 'Identifier') return node.name;
    if (node.type === 'ThisExpression') return 'this';
    if (node.type === 'MemberExpression') {
      const baseObj = this.getObjectName(node.object);
      if (baseObj) return `${baseObj}.${node.property?.name || 'unknown'}`;
    }
    return null;
  }

  private detectLibraryType(libraryName: string): string {
    const libraryMap: Record<string, string> = {
      'fs': 'filesystem',
      'fs-extra': 'filesystem',
      'path': 'path',
      'http': 'http',
      'https': 'http',
      'axios': 'http',
      'fetch': 'http',
      'console': 'logging',
      'process': 'system',
      'crypto': 'crypto',
      'os': 'system',
      'stream': 'stream',
      'Buffer': 'buffer',
      'Promise': 'async',
      'Array': 'builtin',
      'Object': 'builtin',
      'String': 'builtin',
      'Number': 'builtin',
      'Math': 'builtin',
      'Date': 'builtin',
      'JSON': 'builtin',
      'RegExp': 'builtin'
    };

    return libraryMap[libraryName] || 'unknown';
  }

  private extractTypeFromAnnotation(typeNode: any): string | null {
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

  private createDefaultContext(functionName: string): CallContext {
    return {
      enclosingFunction: functionName,
      blockDepth: 0,
      isInTry: false,
      isInCatch: false,
      isInFinally: false,
      isInCallback: false,
      isInPromise: false,
      conditionalDepth: 0,
      loopDepth: 0
    };
  }


  toCASNodes(): CASNode[] {
    const nodes: CASNode[] = [];

    for (const [funcId, func] of this.functions) {
      nodes.push({
        id: funcId,
        name: func.name,
        type: func.type === 'constructor' ? 'constructor' :
              func.type === 'method' ? 'method' : 'function',
        level: func.className ? 3 : 2,
        level_name: func.className ? 'Method/Function' : 'Class/Interface',
        category: func.className ? 'methods' : 'functions',
        subcategories: func.className ? ['class-methods'] : ['standalone'],
        source: {
          file: func.file,
          line: func.lineStart,
          end_line: func.lineEnd,
          column: func.columnStart,
          end_column: func.columnEnd
        },
        metadata: {
          is_exported: func.isExported,
          is_async: func.isAsync,
          is_generated: func.isGenerator,
          attributes: {
            signature: func.signature,
            complexity: func.complexity,
            parameter_count: func.parameters.length
          }
        },
        parent: func.className ? `class_${func.className}` : undefined,
        signature: {
          parameters: func.parameters,
          return_type: func.returnType
        }
      });
    }

    return nodes;
  }

  toCASEdges(): CASEdge[] {
    const edges: CASEdge[] = [];
    let edgeIndex = 0;

    for (const [callerFuncId, func] of this.functions) {
      for (const call of func.calls) {
        const targetFuncId = this.resolveTargetToFunctionId(call.target);

        edges.push({
          id: `call_${edgeIndex++}`,
          source: callerFuncId,
          target: targetFuncId || call.target,
          type: 'calls',
          metadata: {
            attributes: {
              call_type: call.targetType,
              is_async: call.isAsync,
              is_conditional: call.isConditional,
              is_in_loop: call.isInLoop,
              line: call.line,
              library: call.library,
              http_method: call.httpMethod,
              http_path: call.httpPath,
              injection_type: call.injectionType,
              decorators: call.decorators
            }
          }
        });
      }
    }

    return edges;
  }

  toCASEntryPoints(): CASEntryPoint[] {
    const entryPoints: CASEntryPoint[] = [];

    for (const [funcId, func] of this.functions) {

      for (const call of func.calls) {
        if (call.httpMethod && call.httpPath) {
          entryPoints.push({
            id: `http_${funcId}`,
            source_node: funcId,
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


      if (func.isExported) {
        entryPoints.push({
          id: `export_${funcId}`,
          source_node: funcId,
          type: 'file',
          name: `Exported function: ${func.name}`,
          metadata: {
            signature: func.signature
          }
        });
      }
    }

    return entryPoints;
  }

  toCASExitPoints(): CASExitPoint[] {
    const exitPoints: CASExitPoint[] = [];

    for (const [funcId, func] of this.functions) {
      for (const call of func.calls) {
        if (call.targetType === 'library' && call.library) {
          exitPoints.push({
            id: `library_${funcId}_${call.target}`,
            source_node: funcId,
            type: 'sdk',
            name: `${call.library} call`,
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
    }

    return exitPoints;
  }

  private resolveTargetToFunctionId(target: string): string | null {


    const bare = (target.startsWith('this.') || target.startsWith('self.'))
      ? target.slice(target.indexOf('.') + 1)
      : target;
    let fallback: string | null = null;
    for (const [funcId, func] of this.functions) {
      if (func.name === bare || funcId.endsWith(`::${bare}`)) {
        if (func.file === this.currentFile) return funcId;
        fallback = fallback || funcId;
      }
    }
    return fallback;
  }
}