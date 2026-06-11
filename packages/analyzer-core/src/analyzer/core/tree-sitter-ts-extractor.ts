import * as fs from 'fs';

let ParserClass: any = null;
let tsGrammar: any = null;
let tsxGrammar: any = null;
let jsGrammar: any = null;

function loadParser(): any {
  if (!ParserClass) {
    ParserClass = require('tree-sitter');
    const tsModule = require('tree-sitter-typescript');
    tsGrammar = tsModule.typescript;
    tsxGrammar = tsModule.tsx;
    jsGrammar = require('tree-sitter-javascript');
  }
  return ParserClass;
}

function getGrammar(filePath: string): any {
  loadParser();
  if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) {
    return tsxGrammar;
  }
  if (filePath.endsWith('.ts')) {
    return tsGrammar;
  }
  return jsGrammar;
}

export interface TSExtractedImport {
  source: string;
  specifiers: Array<{ name: string; imported?: string; isDefault?: boolean; isNamespace?: boolean }>;
  line: number;
  isTypeOnly: boolean;
}

export interface TSExtractedParameter {
  name: string;
  type?: string;
  optional: boolean;
  defaultValue?: string;
}

export interface TSExtractedCall {
  target: string;
  targetType: 'function' | 'method' | 'constructor' | 'external' | 'unknown' | 'library' | 'property';
  line: number;
  column: number;
  argumentCount: number;
  isAsync: boolean;
  isConditional: boolean;
  isInLoop: boolean;
  callExpression: string;
  context: {
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
  };
}

export interface TSExtractedFunction {
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
  isStatic: boolean;
  className?: string;
  parameters: TSExtractedParameter[];
  returnType?: string;
  calls: TSExtractedCall[];
  complexity: number;
  decorators: string[];
  documentation?: string;
}

export interface TSExtractedProperty {
  name: string;
  type?: string;
  isStatic: boolean;
  isPrivate: boolean;
  isReadonly: boolean;
  isOptional: boolean;
  lineStart: number;
  lineEnd: number;
  decorators: string[];
  defaultValue?: string;
}

export interface TSExtractedClass {
  name: string;
  extends?: string;
  implements: string[];
  methods: TSExtractedFunction[];
  properties: TSExtractedProperty[];
  lineStart: number;
  lineEnd: number;
  isExported: boolean;
  isAbstract: boolean;
  decorators: string[];
  documentation?: string;
}

export interface TSExtractedVariable {
  name: string;
  type?: string;
  value?: string;
  kind: 'const' | 'let' | 'var';
  line: number;
  isExported: boolean;
}

export interface TSExtractedExport {
  name: string;
  exportedName?: string;
  isDefault: boolean;
  isReExport: boolean;
  source?: string;
  line: number;
}

export interface TSFileExtraction {
  imports: TSExtractedImport[];
  functions: TSExtractedFunction[];
  classes: TSExtractedClass[];
  variables: TSExtractedVariable[];
  exports: TSExtractedExport[];
  comments: Array<{ type: string; text: string; line: number }>;
  hasSyntaxErrors: boolean;
}

export function treeHasSyntaxErrors(root: any): boolean {
  try {
    return typeof root.hasError === 'function' ? Boolean(root.hasError()) : Boolean(root.hasError);
  } catch {
    return false;
  }
}

export class TreeSitterTSExtractor {
  private parsers = new Map<string, any>();
  private currentFile: string = '';
  private imports = new Map<string, TSExtractedImport>();

  private getParser(filePath: string): any {
    const grammar = getGrammar(filePath);
    const key = grammar === tsxGrammar ? 'tsx' : grammar === tsGrammar ? 'ts' : 'js';

    if (!this.parsers.has(key)) {
      const Parser = loadParser();
      const parser = new Parser();
      parser.setLanguage(grammar);
      this.parsers.set(key, parser);
    }
    return this.parsers.get(key);
  }

  extractFromSource(content: string, filePath: string): TSFileExtraction {
    this.currentFile = filePath;
    this.imports.clear();

    const parser = this.getParser(filePath);
    const tree = parser.parse(content);
    const root = tree.rootNode;

    const result: TSFileExtraction = {
      imports: this.extractImports(root),
      functions: [],
      classes: [],
      variables: [],
      exports: [],
      comments: this.extractComments(root),
      hasSyntaxErrors: treeHasSyntaxErrors(root)
    };

    const functions = this.extractStandaloneFunctions(root);
    const classes = this.extractClasses(root);

    for (const cls of classes) {
      result.classes.push(cls);
    }

    for (const fn of functions) {
      if (!fn.className) {
        result.functions.push(fn);
      }
    }

    result.variables = this.extractVariables(root);
    result.exports = this.extractExports(root);

    return result;
  }

  extractFromFile(filePath: string): TSFileExtraction | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return this.extractFromSource(content, filePath);
    } catch {
      return null;
    }
  }

  private extractImports(root: any): TSExtractedImport[] {
    const imports: TSExtractedImport[] = [];
    const importNodes = this.collectByType(root, 'import_statement');

    for (const imp of importNodes) {
      const sourceNode = imp.childForFieldName('source') || this.findFirst(imp, 'string');
      if (!sourceNode) continue;

      const source = sourceNode.text.replace(/['"]/g, '');
      const isTypeOnly = imp.text.includes('import type');
      const specifiers: TSExtractedImport['specifiers'] = [];

      const clause = this.findFirst(imp, 'import_clause');
      if (clause) {
        for (let i = 0; i < clause.namedChildCount; i++) {
          const child = clause.namedChild(i);
          if (child.type === 'identifier') {
            specifiers.push({ name: child.text, isDefault: true });
          } else if (child.type === 'namespace_import') {
            const name = child.namedChild(0);
            if (name) specifiers.push({ name: name.text, isNamespace: true });
          } else if (child.type === 'named_imports') {
            const specs = this.collectByType(child, 'import_specifier');
            for (const spec of specs) {
              const name = spec.childForFieldName('name') || spec.namedChild(0);
              const alias = spec.childForFieldName('alias');
              if (name) {
                specifiers.push({
                  name: alias?.text || name.text,
                  imported: alias ? name.text : undefined
                });
              }
            }
          }
        }
      }

      const importInfo: TSExtractedImport = {
        source,
        specifiers,
        line: imp.startPosition.row + 1,
        isTypeOnly
      };

      imports.push(importInfo);

      for (const spec of specifiers) {
        this.imports.set(spec.name, importInfo);
      }
    }

    return imports;
  }

  private extractFunctions(root: any): TSExtractedFunction[] {
    const functions: TSExtractedFunction[] = [];
    const funcTypes = new Set([
      'function_declaration',
      'method_definition',
      'arrow_function',
      'function_expression',
      'generator_function_declaration'
    ]);

    const funcNodes = this.collectByTypes(root, funcTypes);

    for (const func of funcNodes) {
      const extracted = this.extractFunction(func, root);
      if (extracted) {
        functions.push(extracted);
      }
    }

    return functions;
  }

  private extractStandaloneFunctions(root: any): TSExtractedFunction[] {
    const functions: TSExtractedFunction[] = [];
    const funcTypes = new Set([
      'function_declaration',
      'arrow_function',
      'function_expression',
      'generator_function_declaration'
    ]);

    const funcNodes = this.collectByTypesOutsideClasses(root, funcTypes);

    for (const func of funcNodes) {
      const extracted = this.extractFunction(func, root);
      if (extracted && !extracted.className) {
        functions.push(extracted);
      }
    }

    return functions;
  }

  private extractFunction(func: any, root: any): TSExtractedFunction | null {
    let funcName = func.childForFieldName('name')?.text;
    let funcType: TSExtractedFunction['type'] = 'function';
    let className: string | undefined;
    let isStatic = false;
    let isExported = false;

    if (func.type === 'method_definition') {
      funcType = 'method';
      const kindNode = func.children?.find((c: any) => c.type === 'get' || c.type === 'set');
      if (kindNode?.type === 'get') funcType = 'getter';
      if (kindNode?.type === 'set') funcType = 'setter';

      if (funcName === 'constructor') funcType = 'constructor';

      isStatic = func.children?.some((c: any) => c.type === 'static') || false;
    } else if (func.type === 'arrow_function' || func.type === 'function_expression') {
      funcType = 'arrow';

      if (func.parent?.type === 'variable_declarator') {
        const varName = func.parent.childForFieldName('name');
        funcName = varName?.text;

        const varDecl = func.parent.parent;
        if (varDecl?.parent?.type === 'export_statement') {
          isExported = true;
        }
      } else if (func.parent?.type === 'pair') {
        const key = func.parent.childForFieldName('key');
        funcName = key?.text;
      } else if (func.parent?.type === 'assignment_expression') {
        const left = func.parent.childForFieldName('left');
        if (left?.type === 'member_expression') {
          funcName = left.childForFieldName('property')?.text;
        } else if (left?.type === 'identifier') {
          funcName = left.text;
        }
      }
    }

    if (func.type === 'generator_function_declaration') {
      funcType = 'function';
    }

    if (!funcName) return null;

    let parent = func.parent;
    while (parent) {
      if (parent.type === 'class_declaration' || parent.type === 'class') {
        className = parent.childForFieldName('name')?.text;
        break;
      }
      if (parent.type === 'class_body') {
        parent = parent.parent;
        continue;
      }
      parent = parent.parent;
    }

    if (func.type === 'function_declaration') {
      if (func.parent?.type === 'export_statement') {
        isExported = true;
      }
    }

    const isAsync = this.hasAsyncKeyword(func);
    const isGenerator = func.type === 'generator_function_declaration' ||
                       func.children?.some((c: any) => c.type === '*');

    const parameters = this.extractParameters(func);
    const returnType = this.extractReturnType(func);
    const decorators = this.extractDecorators(func);
    const calls = this.extractCalls(func, funcName, className);
    const complexity = this.calculateComplexity(func);
    const documentation = this.extractDocumentation(func);

    const signature = this.buildSignature(funcName, parameters, returnType, isAsync, isGenerator);

    return {
      name: funcName,
      signature,
      file: this.currentFile,
      lineStart: func.startPosition.row + 1,
      lineEnd: func.endPosition.row + 1,
      columnStart: func.startPosition.column,
      columnEnd: func.endPosition.column,
      type: funcType,
      isAsync,
      isGenerator,
      isExported,
      isStatic,
      className,
      parameters,
      returnType,
      calls,
      complexity,
      decorators,
      documentation
    };
  }

  private extractParameters(func: any): TSExtractedParameter[] {
    const params: TSExtractedParameter[] = [];
    const paramsNode = func.childForFieldName('parameters') ||
                       this.findFirst(func, 'formal_parameters');

    if (!paramsNode) return params;

    for (let i = 0; i < paramsNode.namedChildCount; i++) {
      const param = paramsNode.namedChild(i);
      if (!param) continue;

      let name: string | undefined;
      let type: string | undefined;
      let optional = false;
      let defaultValue: string | undefined;

      if (param.type === 'identifier') {
        name = param.text;
      } else if (param.type === 'required_parameter' || param.type === 'optional_parameter') {
        const pattern = param.childForFieldName('pattern');
        name = pattern?.text || param.namedChild(0)?.text;

        const typeAnnotation = param.childForFieldName('type') ||
                               this.findFirst(param, 'type_annotation');
        if (typeAnnotation) {
          type = this.extractTypeText(typeAnnotation);
        }

        optional = param.type === 'optional_parameter' ||
                  param.text.includes('?:') ||
                  param.children?.some((c: any) => c.type === '?');

        const valueNode = param.childForFieldName('value');
        if (valueNode) {
          defaultValue = valueNode.text;
          optional = true;
        }
      } else if (param.type === 'assignment_pattern') {
        const left = param.childForFieldName('left');
        const right = param.childForFieldName('right');
        name = left?.text;
        defaultValue = right?.text;
        optional = true;
      } else if (param.type === 'rest_pattern') {
        name = '...' + (param.namedChild(0)?.text || '');
      }

      if (name) {
        params.push({ name, type, optional, defaultValue });
      }
    }

    return params;
  }

  private extractReturnType(func: any): string | undefined {
    const returnType = func.childForFieldName('return_type') ||
                       this.findFirst(func, 'type_annotation');

    if (returnType && returnType.parent === func) {
      return this.extractTypeText(returnType);
    }
    return undefined;
  }

  private extractTypeText(typeNode: any): string {
    if (typeNode.type === 'type_annotation') {
      return typeNode.namedChild(0)?.text || typeNode.text.replace(/^:\s*/, '');
    }
    return typeNode.text;
  }

  private extractDecorators(node: any): string[] {
    const decorators: string[] = [];
    let sibling = node.previousNamedSibling;

    while (sibling && sibling.type === 'decorator') {
      const call = this.findFirst(sibling, 'call_expression');
      const identifier = this.findFirst(sibling, 'identifier');

      if (call) {
        const callee = call.childForFieldName('function') || call.namedChild(0);
        decorators.unshift(callee?.text?.split('(')[0] || '');
      } else if (identifier) {
        decorators.unshift(identifier.text);
      }

      sibling = sibling.previousNamedSibling;
    }

    return decorators;
  }

  private extractCalls(func: any, enclosingFunction: string, enclosingClass?: string): TSExtractedCall[] {
    const calls: TSExtractedCall[] = [];
    const body = func.childForFieldName('body');
    if (!body) return calls;

    const callNodes = this.collectByType(body, 'call_expression');

    for (const call of callNodes) {
      const extracted = this.extractCall(call, enclosingFunction, enclosingClass);
      if (extracted) {
        calls.push(extracted);
      }
    }

    return calls;
  }

  private extractCall(call: any, enclosingFunction: string, enclosingClass?: string): TSExtractedCall | null {
    const callee = call.childForFieldName('function') || call.namedChild(0);
    if (!callee) return null;

    let target: string;
    let targetType: TSExtractedCall['targetType'] = 'unknown';

    if (callee.type === 'member_expression') {
      const obj = callee.childForFieldName('object');
      const prop = callee.childForFieldName('property');
      target = `${obj?.text || ''}.${prop?.text || ''}`;
      targetType = 'method';

      if (obj?.text && this.imports.has(obj.text)) {
        targetType = 'library';
      }
    } else if (callee.type === 'identifier') {
      target = callee.text;

      if (this.imports.has(target)) {
        targetType = 'external';
      } else if (target[0] === target[0].toUpperCase() && target !== 'Object' && target !== 'Array') {
        targetType = 'constructor';
      } else {
        targetType = 'function';
      }
    } else if (callee.type === 'super') {
      target = 'super';
      targetType = 'constructor';
    } else {
      target = callee.text;
    }

    const args = call.childForFieldName('arguments');
    const argumentCount = args ? args.namedChildCount : 0;

    const isAsync = call.parent?.type === 'await_expression';
    const { isConditional, conditionalDepth, isInLoop, loopDepth, blockDepth, isInTry, isInCatch, isInFinally, isInCallback, isInPromise } = this.analyzeCallContext(call);

    return {
      target,
      targetType,
      line: call.startPosition.row + 1,
      column: call.startPosition.column,
      argumentCount,
      isAsync,
      isConditional,
      isInLoop,
      callExpression: call.text.substring(0, 100),
      context: {
        enclosingFunction,
        enclosingClass,
        blockDepth,
        isInTry,
        isInCatch,
        isInFinally,
        isInCallback,
        isInPromise,
        conditionalDepth,
        loopDepth
      }
    };
  }

  private analyzeCallContext(call: any): {
    isConditional: boolean;
    conditionalDepth: number;
    isInLoop: boolean;
    loopDepth: number;
    blockDepth: number;
    isInTry: boolean;
    isInCatch: boolean;
    isInFinally: boolean;
    isInCallback: boolean;
    isInPromise: boolean;
  } {
    let isConditional = false;
    let conditionalDepth = 0;
    let isInLoop = false;
    let loopDepth = 0;
    let blockDepth = 0;
    let isInTry = false;
    let isInCatch = false;
    let isInFinally = false;
    let isInCallback = false;
    let isInPromise = false;

    let parent = call.parent;
    while (parent) {
      switch (parent.type) {
        case 'if_statement':
        case 'ternary_expression':
        case 'switch_statement':
          isConditional = true;
          conditionalDepth++;
          break;
        case 'for_statement':
        case 'for_in_statement':
        case 'for_of_statement':
        case 'while_statement':
        case 'do_statement':
          isInLoop = true;
          loopDepth++;
          break;
        case 'statement_block':
          blockDepth++;
          break;
        case 'try_statement':
          isInTry = true;
          break;
        case 'catch_clause':
          isInCatch = true;
          break;
        case 'finally_clause':
          isInFinally = true;
          break;
        case 'arrow_function':
        case 'function_expression':
          isInCallback = true;
          break;
        case 'call_expression': {
          const callee = parent.childForFieldName('function') || parent.namedChild(0);
          if (callee?.text?.includes('then') || callee?.text?.includes('catch')) {
            isInPromise = true;
          }
          break;
        }
      }
      parent = parent.parent;
    }

    return { isConditional, conditionalDepth, isInLoop, loopDepth, blockDepth, isInTry, isInCatch, isInFinally, isInCallback, isInPromise };
  }

  private calculateComplexity(func: any): number {
    let complexity = 1;
    const body = func.childForFieldName('body');
    if (!body) return complexity;

    const complexityNodes = new Set([
      'if_statement', 'ternary_expression', 'switch_case',
      'for_statement', 'for_in_statement', 'for_of_statement',
      'while_statement', 'do_statement',
      'catch_clause',
      'binary_expression'
    ]);

    const stack = [body];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (complexityNodes.has(node.type)) {
        if (node.type === 'binary_expression') {
          const op = node.childForFieldName('operator')?.text;
          if (op === '&&' || op === '||' || op === '??') {
            complexity++;
          }
        } else {
          complexity++;
        }
      }
      for (let i = node.namedChildCount - 1; i >= 0; i--) {
        stack.push(node.namedChild(i));
      }
    }

    return complexity;
  }

  private extractDocumentation(node: any): string | undefined {
    let sibling = node.previousSibling;
    while (sibling && (sibling.type === 'decorator' || sibling.type === 'comment')) {
      if (sibling.type === 'comment' && sibling.text.startsWith('/**')) {
        return sibling.text;
      }
      sibling = sibling.previousSibling;
    }
    return undefined;
  }

  private extractClasses(root: any): TSExtractedClass[] {
    const classes: TSExtractedClass[] = [];
    const classNodes = this.collectByType(root, 'class_declaration');

    for (const cls of classNodes) {
      const extracted = this.extractClass(cls);
      if (extracted) {
        classes.push(extracted);
      }
    }

    return classes;
  }

  private extractClass(cls: any): TSExtractedClass | null {
    const nameNode = cls.childForFieldName('name');
    const className = nameNode?.text;
    if (!className) return null;

    let extendsClause: string | undefined;
    let implementsClause: string[] = [];

    const heritage = cls.childForFieldName('heritage') ||
                     this.findFirst(cls, 'class_heritage');

    if (heritage) {
      for (let i = 0; i < heritage.namedChildCount; i++) {
        const clause = heritage.namedChild(i);
        if (clause.type === 'extends_clause') {
          const type = clause.namedChild(0);
          extendsClause = type?.text;
        } else if (clause.type === 'implements_clause') {
          for (let j = 0; j < clause.namedChildCount; j++) {
            const impl = clause.namedChild(j);
            if (impl) implementsClause.push(impl.text);
          }
        }
      }
    }

    const isExported = cls.parent?.type === 'export_statement';
    const isAbstract = cls.children?.some((c: any) => c.type === 'abstract') || false;
    const decorators = this.extractDecorators(cls);
    const documentation = this.extractDocumentation(cls);

    const body = cls.childForFieldName('body');
    const methods: TSExtractedFunction[] = [];
    const properties: TSExtractedProperty[] = [];

    if (body) {
      for (let i = 0; i < body.namedChildCount; i++) {
        const member = body.namedChild(i);
        if (!member) continue;

        if (member.type === 'method_definition') {
          const method = this.extractFunction(member, cls);
          if (method) {
            method.className = className;
            methods.push(method);
          }
        } else if (member.type === 'public_field_definition' ||
                   member.type === 'field_definition' ||
                   member.type === 'property_definition') {
          const prop = this.extractProperty(member);
          if (prop) {
            properties.push(prop);
          }
        }
      }
    }

    return {
      name: className,
      extends: extendsClause,
      implements: implementsClause,
      methods,
      properties,
      lineStart: cls.startPosition.row + 1,
      lineEnd: cls.endPosition.row + 1,
      isExported,
      isAbstract,
      decorators,
      documentation
    };
  }

  private extractProperty(prop: any): TSExtractedProperty | null {
    const nameNode = prop.childForFieldName('name') || prop.namedChild(0);
    const name = nameNode?.text;
    if (!name) return null;

    const typeAnnotation = prop.childForFieldName('type') ||
                           this.findFirst(prop, 'type_annotation');
    const type = typeAnnotation ? this.extractTypeText(typeAnnotation) : undefined;

    const isStatic = prop.children?.some((c: any) => c.type === 'static') || false;
    const isPrivate = name.startsWith('#') ||
                     prop.children?.some((c: any) => c.type === 'private') || false;
    const isReadonly = prop.children?.some((c: any) => c.type === 'readonly') || false;
    const isOptional = prop.text.includes('?:') ||
                      prop.children?.some((c: any) => c.type === '?');

    const valueNode = prop.childForFieldName('value');
    const defaultValue = valueNode?.text;

    const decorators = this.extractDecorators(prop);

    return {
      name,
      type,
      isStatic,
      isPrivate,
      isReadonly,
      isOptional: isOptional || false,
      lineStart: prop.startPosition.row + 1,
      lineEnd: prop.endPosition.row + 1,
      decorators,
      defaultValue
    };
  }

  private extractVariables(root: any): TSExtractedVariable[] {
    const variables: TSExtractedVariable[] = [];
    const varDeclNodes = this.collectByTypes(root, new Set(['lexical_declaration', 'variable_declaration']));

    for (const decl of varDeclNodes) {
      if (this.isInsideFunction(decl)) continue;

      const kind = decl.children?.[0]?.text as 'const' | 'let' | 'var' || 'const';
      const isExported = decl.parent?.type === 'export_statement';

      const declarators = this.collectByType(decl, 'variable_declarator');
      for (const declarator of declarators) {
        const nameNode = declarator.childForFieldName('name');
        const valueNode = declarator.childForFieldName('value');
        const typeNode = declarator.childForFieldName('type') ||
                        this.findFirst(declarator, 'type_annotation');

        const name = nameNode?.text;
        if (!name) continue;

        if (valueNode?.type === 'arrow_function' || valueNode?.type === 'function_expression') {
          continue;
        }

        variables.push({
          name,
          type: typeNode ? this.extractTypeText(typeNode) : undefined,
          value: valueNode?.text,
          kind,
          line: declarator.startPosition.row + 1,
          isExported
        });
      }
    }

    return variables;
  }

  private extractExports(root: any): TSExtractedExport[] {
    const exports: TSExtractedExport[] = [];
    const exportNodes = this.collectByType(root, 'export_statement');

    for (const exp of exportNodes) {
      const isDefault = exp.text.includes('export default');

      const exportClause = this.findFirst(exp, 'export_clause');
      if (exportClause) {
        const specifiers = this.collectByType(exportClause, 'export_specifier');
        for (const spec of specifiers) {
          const name = spec.childForFieldName('name')?.text || spec.namedChild(0)?.text;
          const alias = spec.childForFieldName('alias')?.text;

          if (name) {
            exports.push({
              name,
              exportedName: alias,
              isDefault: false,
              isReExport: !!this.findFirst(exp, 'string'),
              source: this.findFirst(exp, 'string')?.text?.replace(/['"]/g, ''),
              line: exp.startPosition.row + 1
            });
          }
        }
      } else {
        const declaration = exp.namedChild(exp.text.includes('export default') ? 1 : 0);
        if (declaration) {
          let name: string | undefined;

          if (declaration.type === 'function_declaration' ||
              declaration.type === 'class_declaration') {
            name = declaration.childForFieldName('name')?.text;
          } else if (declaration.type === 'lexical_declaration' ||
                     declaration.type === 'variable_declaration') {
            const declarator = this.findFirst(declaration, 'variable_declarator');
            name = declarator?.childForFieldName('name')?.text;
          } else if (declaration.type === 'identifier') {
            name = declaration.text;
          }

          if (name) {
            exports.push({
              name,
              isDefault,
              isReExport: false,
              line: exp.startPosition.row + 1
            });
          }
        }
      }
    }

    return exports;
  }

  private extractComments(root: any): Array<{ type: string; text: string; line: number }> {
    const comments: Array<{ type: string; text: string; line: number }> = [];

    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.type === 'comment') {
        let type = 'line';
        if (node.text.startsWith('/**')) type = 'jsdoc';
        else if (node.text.startsWith('/*')) type = 'block';

        comments.push({
          type,
          text: node.text,
          line: node.startPosition.row + 1
        });
      }
      for (let i = node.childCount - 1; i >= 0; i--) {
        stack.push(node.child(i));
      }
    }

    return comments;
  }

  private isInsideFunction(node: any): boolean {
    let parent = node.parent;
    while (parent) {
      if (parent.type === 'function_declaration' ||
          parent.type === 'method_definition' ||
          parent.type === 'arrow_function' ||
          parent.type === 'function_expression') {
        return true;
      }
      parent = parent.parent;
    }
    return false;
  }

  private hasAsyncKeyword(node: any): boolean {
    if (node.text.startsWith('async')) return true;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'async') return true;
    }
    return false;
  }

  private buildSignature(
    name: string,
    params: TSExtractedParameter[],
    returnType: string | undefined,
    isAsync: boolean,
    isGenerator: boolean
  ): string {
    const prefix = isAsync ? 'async ' : '';
    const gen = isGenerator ? '*' : '';
    const paramStr = params.map(p => {
      let str = p.name;
      if (p.type) str += `: ${p.type}`;
      if (p.optional && !p.defaultValue) str = str.replace(p.name, p.name + '?');
      if (p.defaultValue) str += ` = ${p.defaultValue}`;
      return str;
    }).join(', ');
    const ret = returnType ? `: ${returnType}` : '';
    return `${prefix}function${gen} ${name}(${paramStr})${ret}`;
  }

  private collectByType(node: any, type: string): any[] {
    const results: any[] = [];
    const stack = [node];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.type === type) {
        results.push(current);
      }
      for (let i = current.namedChildCount - 1; i >= 0; i--) {
        stack.push(current.namedChild(i));
      }
    }
    return results;
  }

  private collectByTypes(node: any, types: Set<string>): any[] {
    const results: any[] = [];
    const stack = [node];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (types.has(current.type)) {
        results.push(current);
      }
      for (let i = current.namedChildCount - 1; i >= 0; i--) {
        stack.push(current.namedChild(i));
      }
    }
    return results;
  }

  private collectByTypesOutsideClasses(node: any, types: Set<string>): any[] {
    const results: any[] = [];
    const stack = [node];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current !== node && (current.type === 'class_declaration' || current.type === 'class')) {
        continue;
      }
      if (types.has(current.type)) {
        results.push(current);
      }
      for (let i = current.namedChildCount - 1; i >= 0; i--) {
        stack.push(current.namedChild(i));
      }
    }
    return results;
  }

  private findFirst(node: any, type: string): any | null {
    if (node.type === type) return node;
    for (let i = 0; i < node.namedChildCount; i++) {
      const found = this.findFirst(node.namedChild(i), type);
      if (found) return found;
    }
    return null;
  }
}
