import * as fs from 'fs';
import { NativeAddonUnavailableError, isNativeAddonUnavailableError } from './errors';
import {
  classifyKnownTypeScriptGrammarLimitation, sanitizeContextualUsingIdentifiers,
  sanitizeInlineImportTypePrefixes, sanitizeTaggedTemplateTypeArguments,
} from './tree-sitter-grammar-limitations';
import { originalNodeText, recoverTypeScriptTree } from './tree-sitter-ts-recovery';

export function sanitizeForTreeSitterParse(source: string): string {
  return source.indexOf('\0') === -1 ? source : source.replace(/\0/g, ' ');
}

const ABSTRACT_AS_PROPERTY_KEY = /([{;,\n]\s*)abstract(\??\s*:)/g;
export function sanitizeAbstractPropertyKeyword(source: string): string {
  return source.indexOf('abstract') === -1
    ? source
    : source.replace(ABSTRACT_AS_PROPERTY_KEY, (_m, pre, suf) => `${pre}"abstract"${suf}`);
}

let ParserClass: any = null;
let tsGrammar: any = null;
let tsxGrammar: any = null;
let jsGrammar: any = null;

let loadFailure: NativeAddonUnavailableError | null = null;

function loadParser(): any {
  if (loadFailure) throw loadFailure;
  if (!ParserClass) {
    try {
      ParserClass = require('tree-sitter');
      const tsModule = require('tree-sitter-typescript');
      tsGrammar = tsModule.typescript;
      tsxGrammar = tsModule.tsx;
      jsGrammar = require('tree-sitter-javascript');
    } catch (error) {
      loadFailure = new NativeAddonUnavailableError('tree-sitter (typescript/javascript)', error);
      ParserClass = null;
      throw loadFailure;
    }
  }
  return ParserClass;
}

const SAVED_ROOT_NODE_DESCRIPTOR = '__klauroSavedRootNodeDescriptor';

function getRootNode(tree: any): any {
  if (!tree) return undefined;
  let root = tree.rootNode;
  const proto = Object.getPrototypeOf(tree);
  if (!proto) return root;
  if (root) {
    if (!Object.prototype.hasOwnProperty.call(proto, SAVED_ROOT_NODE_DESCRIPTOR)) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'rootNode');
      if (descriptor) {
        Object.defineProperty(proto, SAVED_ROOT_NODE_DESCRIPTOR, { value: descriptor, configurable: true });
      }
    }
    return root;
  }
  const saved = (proto as any)[SAVED_ROOT_NODE_DESCRIPTOR];
  if (saved) {
    Object.defineProperty(proto, 'rootNode', saved);
    root = tree.rootNode;
  }
  return root;
}

function nodeIdEquals(a: any, b: any): boolean {
  if (!a || !b) return false;
  return a.id === b.id;
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

export const UNRESOLVED_RECEIVER = '<unresolved>';

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

export interface TSDecoratorArg {
  name: string;
  value: string | number | boolean | null;
  type: 'string' | 'number' | 'boolean' | 'null';
}

export interface TSDecoratorDetail {
  name: string;
  args: TSDecoratorArg[];
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
  decoratorArgs?: TSDecoratorDetail[];
  documentation?: string;
  throws?: string[];
  isAnonymousCallback?: boolean;
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
  decoratorArgs?: TSDecoratorDetail[];
  defaultValue?: string;
}

export interface TSExtractedClass {
  name: string;
  kind?: 'class' | 'interface' | 'type';
  extends?: string;
  implements: string[];
  methods: TSExtractedFunction[];
  properties: TSExtractedProperty[];
  lineStart: number;
  lineEnd: number;
  isExported: boolean;
  isAbstract: boolean;
  decorators: string[];
  decoratorArgs?: TSDecoratorDetail[];
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

export interface TSSyntaxErrorLocation {
  line: number;
  snippet: string;
  knownLimitation?: string;
}

export interface TSFileExtraction {
  imports: TSExtractedImport[];
  functions: TSExtractedFunction[];
  classes: TSExtractedClass[];
  variables: TSExtractedVariable[];
  exports: TSExtractedExport[];
  comments: Array<{ type: string; text: string; line: number }>;
  hasSyntaxErrors: boolean;
  syntaxErrorLocations?: TSSyntaxErrorLocation[];
}

export function treeHasSyntaxErrors(root: any): boolean {
  try {
    return typeof root.hasError === 'function' ? Boolean(root.hasError()) : Boolean(root.hasError);
  } catch {
    return false;
  }
}

const MAX_SYNTAX_ERROR_LOCATIONS = 3;
const SYNTAX_ERROR_SNIPPET_MAX_LEN = 40;

function sanitizeSyntaxErrorSnippet(raw: string): string {
  const escaped = Array.from(raw).map(ch => {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return `\\u${code.toString(16).padStart(4, '0')}`;
    }
    return ch;
  }).join('');
  const collapsed = escaped.replace(/\s+/g, ' ').trim();
  return collapsed.length > SYNTAX_ERROR_SNIPPET_MAX_LEN
    ? `${collapsed.slice(0, SYNTAX_ERROR_SNIPPET_MAX_LEN)}…`
    : collapsed;
}

export function collectSyntaxErrorLocations(root: any, sourceLines?: string[]): TSSyntaxErrorLocation[] {
  const locations: TSSyntaxErrorLocation[] = [];
  if (!root) return locations;
  const stack: any[] = [root];
  try {
    while (stack.length > 0 && locations.length < MAX_SYNTAX_ERROR_LOCATIONS) {
      const node = stack.pop();
      if (!node) continue;
      if (node.type === 'ERROR' || node.isMissing) {
        const line = (node.startPosition?.row ?? 0) + 1;
        const lineText = sourceLines?.[line - 1];
        const knownLimitation = classifyKnownTypeScriptGrammarLimitation(lineText, line, sourceLines);
        locations.push({
          line,
          snippet: sanitizeSyntaxErrorSnippet(String(node.text ?? '')),
          ...(knownLimitation ? { knownLimitation } : {})
        });
        continue;
      }
      const childCount = node.childCount ?? 0;
      for (let i = childCount - 1; i >= 0; i--) {
        stack.push(node.child(i));
      }
    }
  } catch {
  }
  return locations;
}

const EXTRACTED_FUNCTION_TYPES = new Set([
  'function_declaration',
  'method_definition',
  'arrow_function',
  'function_expression',
  'generator_function_declaration'
]);

const THROW_FUNCTION_BOUNDARY_TYPES = new Set([
  ...EXTRACTED_FUNCTION_TYPES,
  'generator_function'
]);

const VARIABLE_FUNCTION_TYPES = new Set([
  'function_declaration',
  'method_definition',
  'arrow_function',
  'function_expression'
]);

const CLASS_CONTAINER_TYPES = new Set([
  'class_declaration',
  'class',
  'abstract_class_declaration'
]);

const COMPLEXITY_NODE_TYPES = new Set([
  'if_statement', 'ternary_expression', 'switch_case',
  'for_statement', 'for_in_statement', 'for_of_statement',
  'while_statement', 'do_statement', 'catch_clause', 'binary_expression'
]);

type TSCallContextFacts = Omit<TSExtractedCall['context'], 'enclosingFunction' | 'enclosingClass'> & {
  isConditional: boolean;
  isInLoop: boolean;
};

interface TSIndexedCall {
  node: any;
  isAsync: boolean;
  context: TSCallContextFacts;
}

interface TSIndexedIdentifier {
  node: any;
  parent: any | null;
  excludeFromReference: boolean;
  conditionalDepth: number;
  loopDepth: number;
}

interface TSFunctionTraversal {
  node: any;
  parent: any | null;
  grandparent: any | null;
  className?: string;
  hasEnclosingFunction: boolean;
  calls: TSIndexedCall[];
  identifiers: TSIndexedIdentifier[];
  complexity: number;
  throwTypes: Set<string>;
}

interface TSRootTraversal {
  imports: any[];
  classes: any[];
  variables: any[];
  exports: any[];
  comments: Array<{ type: string; text: string; line: number }>;
  standaloneFunctions: any[];
  objectMethods: any[];
  functions: Map<any, TSFunctionTraversal>;
}

interface TSTraversalFrame {
  node: any;
  parent: any | null;
  grandparent: any | null;
  parentType?: string;
  classDepth: number;
  className?: string;
  variableFunctionDepth: number;
  enclosingFunctionDepth: number;
  activeFunctions: TSFunctionTraversal[];
  throwBoundaries: Array<TSFunctionTraversal | undefined>;
  conditionalDepth: number;
  loopDepth: number;
  blockDepth: number;
  tryDepth: number;
  catchDepth: number;
  finallyDepth: number;
  callbackDepth: number;
  promiseDepth: number;
}

export class TreeSitterTSExtractor {
  private parsers = new Map<string, any>();
  private currentFile: string = ''; private currentSource = Buffer.alloc(0);
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
    this.currentFile = filePath; this.currentSource = Buffer.from(content);
    this.imports.clear();

    const parser = this.getParser(filePath);
    const forParse = sanitizeContextualUsingIdentifiers(
      sanitizeInlineImportTypePrefixes(
        sanitizeTaggedTemplateTypeArguments(sanitizeAbstractPropertyKeyword(sanitizeForTreeSitterParse(content))),
      ),
    );
    const initialTree = parser.parse(forParse);
    const { tree, root, hasSyntaxErrors } = recoverTypeScriptTree(parser, initialTree, content, forParse, getRootNode, treeHasSyntaxErrors, collectSyntaxErrorLocations);
    try {
      const traversal = this.buildTraversalIndex(root);

      const result: TSFileExtraction = {
        imports: this.extractImports(root, traversal.imports),
        functions: [],
        classes: [],
        variables: [],
        exports: [],
        comments: traversal.comments,
        hasSyntaxErrors,
        syntaxErrorLocations: hasSyntaxErrors
          ? collectSyntaxErrorLocations(root, content.split('\n'))
          : undefined
      };

      const functions = this.extractStandaloneFunctions(traversal);
      const classes = this.extractClasses(root, traversal.classes, traversal);

      for (const cls of classes) {
        result.classes.push(cls);
      }

      for (const fn of functions) {
        if (!fn.className) {
          result.functions.push(fn);
        }
      }

      result.variables = this.extractVariables(root, traversal.variables, true);
      result.exports = this.extractExports(root, traversal.exports);

      return result;
    } finally {
      tree.delete?.();
    }
  }

  extractFromFile(filePath: string): TSFileExtraction | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return this.extractFromSource(content, filePath);
    } catch (error) {
      if (isNativeAddonUnavailableError(error)) throw error;
      return null;
    }
  }

  private extractImports(root: any, preCollected?: any[]): TSExtractedImport[] {
    const imports: TSExtractedImport[] = [];
    const importNodes = preCollected ?? this.collectByType(root, 'import_statement');

    for (const imp of importNodes) {
      const sourceNode = imp.childForFieldName('source') || this.findFirst(imp, 'string');
      if (!sourceNode) continue;

      const source = sourceNode.text.replace(/['"]/g, '');
      const isTypeOnly = imp.text.includes('import type');
      const specifiers: TSExtractedImport['specifiers'] = [];

      const clause = this.findFirst(imp, 'import_clause');
      if (clause) {
        for (let i = 0, n = clause.namedChildCount; i < n; i++) {
          const child = clause.namedChild(i);
          if (!child) continue;
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

  private extractStandaloneFunctions(traversal: TSRootTraversal): TSExtractedFunction[] {
    const functions: TSExtractedFunction[] = [];

    for (const func of traversal.standaloneFunctions) {
      const extracted = this.extractFunction(func, traversal.functions.get(func.id));
      if (extracted && !extracted.className) {
        functions.push(extracted);
      }
    }

    for (const func of traversal.objectMethods) {
      const extracted = this.extractFunction(func, traversal.functions.get(func.id));
      if (extracted && !extracted.className) {
        functions.push(extracted);
      }
    }

    return functions;
  }

  private extractFunction(func: any, traversal?: TSFunctionTraversal): TSExtractedFunction | null {
    let funcName = func.childForFieldName('name')?.text;
    let funcType: TSExtractedFunction['type'] = 'function';
    let className = traversal?.className;
    let isStatic = false;
    let isExported = false;
    const parent = traversal?.parent ?? func.parent;
    const grandparent = traversal?.grandparent ?? parent?.parent;

    if (func.type === 'method_definition') {
      funcType = 'method';
      const kindNode = func.children?.find((c: any) => c.type === 'get' || c.type === 'set');
      if (kindNode?.type === 'get') funcType = 'getter';
      if (kindNode?.type === 'set') funcType = 'setter';

      if (funcName === 'constructor') funcType = 'constructor';

      isStatic = func.children?.some((c: any) => c.type === 'static') || false;
    } else if (func.type === 'arrow_function' || func.type === 'function_expression') {
      funcType = 'arrow';

      if (parent?.type === 'variable_declarator') {
        const varName = parent.childForFieldName('name');
        funcName = varName?.text;

        const varDecl = grandparent;
        if (varDecl?.parent?.type === 'export_statement') {
          isExported = true;
        }
      } else if (parent?.type === 'pair') {
        const key = parent.childForFieldName('key');
        funcName = key?.text;
      } else if (parent?.type === 'assignment_expression') {
        const left = parent.childForFieldName('left');
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

    let isAnonymousCallback = false;
    if (!funcName &&
        (func.type === 'arrow_function' || func.type === 'function_expression') &&
        parent?.type === 'arguments' &&
        !(traversal?.hasEnclosingFunction ?? this.hasEnclosingFunction(func))) {
      funcName = 'anonymous';
      isAnonymousCallback = true;
    }

    if (!funcName) return null;

    let classParent = traversal ? null : func.parent;
    while (classParent) {
      if (classParent.type === 'class_declaration' || classParent.type === 'class' || classParent.type === 'abstract_class_declaration') {
        className = classParent.childForFieldName('name')?.text;
        break;
      }
      if (classParent.type === 'class_body') {
        classParent = classParent.parent;
        continue;
      }
      classParent = classParent.parent;
    }

    if (func.type === 'function_declaration') {
      if (parent?.type === 'export_statement') {
        isExported = true;
      }
    }

    const isAsync = this.hasAsyncKeyword(func);
    const isGenerator = func.type === 'generator_function_declaration' ||
                       func.children?.some((c: any) => c.type === '*');

    const parameters = this.extractParameters(func);
    const returnType = this.extractReturnType(func);
    const decorators = this.extractDecorators(func);
    const decoratorArgs = this.extractDecoratorArgs(func);
    const calls = this.extractCalls(func, funcName, className, traversal);
    const complexity = traversal?.complexity ?? this.calculateComplexity(func);
    const documentation = this.extractDocumentation(func);
    const throws = traversal
      ? (traversal.throwTypes.size > 0 ? Array.from(traversal.throwTypes) : undefined)
      : this.extractThrows(func);

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
      decoratorArgs,
      documentation,
      throws,
      isAnonymousCallback
    };
  }

  private extractThrows(func: any): string[] | undefined {
    const body = func.childForFieldName('body');
    if (!body) return undefined;

    const nestedFnTypes = new Set([
      'function_declaration', 'generator_function_declaration',
      'method_definition', 'arrow_function',
      'function_expression', 'generator_function'
    ]);

    const types = new Set<string>();
    const stack: any[] = [body];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (!node) continue;
      if (node !== body && nestedFnTypes.has(node.type)) continue;
      if (node.type === 'throw_statement') {
        const typeName = this.throwTypeName(node);
        if (typeName) types.add(typeName);
      }
      for (let i = node.namedChildCount - 1; i >= 0; i--) {
        const child = node.namedChild(i);
        if (child) stack.push(child);
      }
    }

    return types.size > 0 ? Array.from(types) : undefined;
  }

  private throwTypeName(throwStmt: any): string | undefined {
    const expr = throwStmt.namedChild(0);
    if (!expr) return undefined;

    if (expr.type === 'new_expression') {
      const ctor = expr.childForFieldName('constructor');
      return this.identifierTail(ctor);
    }

    if (expr.type === 'call_expression') {
      const callee = expr.childForFieldName('function');
      const name = this.identifierTail(callee);
      if (name && /^[A-Z]/.test(name)) return name;
      return undefined;
    }

    return undefined;
  }

  private identifierTail(node: any): string | undefined {
    if (!node) return undefined;
    if (node.type === 'identifier') return node.text;
    if (node.type === 'member_expression') {
      return node.childForFieldName('property')?.text;
    }
    return undefined;
  }

  private hasEnclosingFunction(node: any): boolean {
    const fnTypes = new Set([
      'function_declaration',
      'method_definition',
      'arrow_function',
      'function_expression',
      'generator_function_declaration'
    ]);
    let parent = node.parent;
    while (parent) {
      if (fnTypes.has(parent.type)) return true;
      parent = parent.parent;
    }
    return false;
  }

  private extractParameters(func: any): TSExtractedParameter[] {
    const params: TSExtractedParameter[] = [];
    const paramsNode = func.childForFieldName('parameters') ||
                       this.findFirst(func, 'formal_parameters');

    if (!paramsNode) return params;

    for (let i = 0, n = paramsNode.namedChildCount; i < n; i++) {
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

    if (returnType && nodeIdEquals(returnType.parent, func)) {
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

  private extractDecoratorArgs(node: any): TSDecoratorDetail[] {
    const details: TSDecoratorDetail[] = [];

    const decoratorNodes: any[] = [];
    for (const child of node.namedChildren || []) {
      if (child.type === 'decorator') decoratorNodes.push(child);
      else break;
    }
    const siblingDecorators: any[] = [];
    let sibling = node.previousNamedSibling;
    while (sibling && sibling.type === 'decorator') {
      siblingDecorators.unshift(sibling);
      sibling = sibling.previousNamedSibling;
    }
    decoratorNodes.push(...siblingDecorators);

    for (const decoratorNode of decoratorNodes) {
      const call = this.findFirst(decoratorNode, 'call_expression');
      const calleeNode = call
        ? (call.childForFieldName('function') || call.namedChild(0))
        : this.findFirst(decoratorNode, 'identifier');
      const name = call
        ? (calleeNode?.text?.split('(')[0] || '')
        : (calleeNode?.text || '');

      if (name) {
        const args: TSDecoratorArg[] = [];
        const argList = call?.childForFieldName('arguments');
        if (argList) {
          let positional = 0;
          for (let i = 0, n = argList.namedChildCount; i < n; i++) {
            const argNode = argList.namedChild(i);
            if (!argNode) continue;

            if (argNode.type === 'object') {
              for (let p = 0; p < argNode.namedChildCount; p++) {
                const pair = argNode.namedChild(p);
                if (!pair || pair.type !== 'pair') continue;
                const keyNode = pair.childForFieldName('key');
                const valueNode = pair.childForFieldName('value');
                const key = this.decoratorObjectKey(keyNode);
                if (!key) continue;
                const evaluated = this.evaluateLiteralNode(valueNode);
                if (evaluated) args.push({ name: key, value: evaluated.value, type: evaluated.type });
              }
              positional++;
              continue;
            }


            const evaluated = this.evaluateLiteralNode(argNode);
            if (evaluated) args.push({ name: String(positional), value: evaluated.value, type: evaluated.type });
            positional++;
          }
        }
        details.push({ name, args });
      }
    }

    return details;
  }

  private decoratorObjectKey(keyNode: any): string | undefined {
    if (!keyNode) return undefined;
    if (keyNode.type === 'property_identifier') return keyNode.text;
    if (keyNode.type === 'string') {
      const evaluated = this.evaluateLiteralNode(keyNode);
      return evaluated && typeof evaluated.value === 'string' ? evaluated.value : undefined;
    }
    return undefined;
  }

  private evaluateLiteralNode(node: any): { value: string | number | boolean | null; type: TSDecoratorArg['type'] } | undefined {
    if (!node) return undefined;
    switch (node.type) {
      case 'string': {
        const fragments = node.namedChildren
          .filter((c: any) => c.type === 'string_fragment' || c.type === 'escape_sequence')
          .map((c: any) => c.text);
        return { value: fragments.join(''), type: 'string' };
      }
      case 'template_string': {
        if (this.findFirst(node, 'template_substitution')) return undefined;
        const fragments = node.namedChildren
          .filter((c: any) => c.type === 'string_fragment' || c.type === 'escape_sequence')
          .map((c: any) => c.text);
        return { value: fragments.join(''), type: 'string' };
      }
      case 'number': {
        const n = Number(node.text);
        return Number.isNaN(n) ? undefined : { value: n, type: 'number' };
      }
      case 'true':
        return { value: true, type: 'boolean' };
      case 'false':
        return { value: false, type: 'boolean' };
      case 'null':
        return { value: null, type: 'null' };
      default:
        return undefined;
    }
  }

  private extractCalls(
    func: any,
    enclosingFunction: string,
    enclosingClass?: string,
    traversal?: TSFunctionTraversal
  ): TSExtractedCall[] {
    const calls: TSExtractedCall[] = [];
    const body = func.childForFieldName('body');
    if (!body) return calls;

    const needIdentifiers = this.imports.size > 0;
    let callNodes: TSIndexedCall[];
    let identifierNodes: TSIndexedIdentifier[];
    if (traversal) {
      callNodes = traversal.calls;
      identifierNodes = needIdentifiers ? traversal.identifiers : [];
    } else {
      callNodes = [];
      identifierNodes = [];
      const stack = [body];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (!current) continue;
        const t = current.type;
        if (t === 'call_expression') {
          callNodes.push({
            node: current,
            isAsync: current.parent?.type === 'await_expression',
            context: this.analyzeCallContext(current)
          });
        } else if (needIdentifiers && t === 'identifier') {
          const parent = current.parent;
          const parentType = parent?.type;
          let excludeFromReference = parentType === 'import_specifier' ||
            parentType === 'import_clause' || parentType === 'namespace_import';
          if (!excludeFromReference && parent &&
              (parentType === 'call_expression' || parentType === 'new_expression')) {
            excludeFromReference = nodeIdEquals(parent.childForFieldName('function'), current);
          }
          identifierNodes.push({
            node: current,
            parent,
            excludeFromReference,
            conditionalDepth: -1,
            loopDepth: -1
          });
        }
        for (let i = current.namedChildCount - 1; i >= 0; i--) {
          const child = current.namedChild(i);
          if (child) stack.push(child);
        }
      }
    }

    for (const call of callNodes) {
      const extracted = this.extractCall(call.node, enclosingFunction, enclosingClass, call);
      if (extracted) {
        calls.push(extracted);
      }
    }

    const seenAtLine = new Set<string>();
    calls.push(...this.extractIdentifierReferences(body, enclosingFunction, enclosingClass, seenAtLine, identifierNodes));

    calls.push(...this.extractDecoratorArgumentReferences(func, enclosingFunction, enclosingClass, seenAtLine));

    return calls;
  }

  private extractIdentifierReferences(
    body: any,
    enclosingFunction: string,
    enclosingClass: string | undefined,
    seenAtLine: Set<string>,
    preCollected?: TSIndexedIdentifier[]
  ): TSExtractedCall[] {
    const refs: TSExtractedCall[] = [];
    if (this.imports.size === 0) return refs;

    if (preCollected) {
      for (const identifier of preCollected) {
        const ref = this.buildIdentifierReference(identifier.node, enclosingFunction, enclosingClass, seenAtLine, identifier);
        if (ref) refs.push(ref);
      }
    } else {
      for (const idNode of this.collectByType(body, 'identifier')) {
        const ref = this.buildIdentifierReference(idNode, enclosingFunction, enclosingClass, seenAtLine);
        if (ref) refs.push(ref);
      }
    }

    return refs;
  }

  private buildIdentifierReference(
    idNode: any,
    enclosingFunction: string,
    enclosingClass: string | undefined,
    seenAtLine: Set<string>,
    indexed?: TSIndexedIdentifier
  ): TSExtractedCall | null {
    const name = idNode.text;
    if (!this.imports.has(name)) return null;

    const parent = indexed?.parent ?? idNode.parent;
    if (!parent) return null;

    if (indexed?.excludeFromReference) return null;
    if (!indexed) {
      if (parent.type === 'call_expression' && nodeIdEquals(parent.childForFieldName('function'), idNode)) return null;
      if (parent.type === 'new_expression' && nodeIdEquals(parent.childForFieldName('function'), idNode)) return null;
      if (parent.type === 'import_specifier' || parent.type === 'import_clause' ||
          parent.type === 'namespace_import') return null;
    }

    const line = idNode.startPosition.row + 1;
    const dedupeKey = `${name}:${line}`;
    if (seenAtLine.has(dedupeKey)) return null;
    seenAtLine.add(dedupeKey);

    let conditionalDepth = indexed?.conditionalDepth ?? -1;
    let loopDepth = indexed?.loopDepth ?? -1;
    if (conditionalDepth < 0 || loopDepth < 0) {
      conditionalDepth = 0;
      loopDepth = 0;
      let parentNode = idNode.parent;
      while (parentNode) {
        if (parentNode.type === 'if_statement' || parentNode.type === 'ternary_expression' || parentNode.type === 'switch_statement') {
          conditionalDepth++;
        } else if (parentNode.type === 'for_statement' || parentNode.type === 'for_in_statement' ||
                   parentNode.type === 'for_of_statement' || parentNode.type === 'while_statement' ||
                   parentNode.type === 'do_statement') {
          loopDepth++;
        }
        parentNode = parentNode.parent;
      }
    }

    return {
      target: name,
      targetType: 'property',
      line,
      column: idNode.startPosition.column,
      argumentCount: 0,
      isAsync: false,
      isConditional: conditionalDepth > 0,
      isInLoop: loopDepth > 0,
      callExpression: name,
      context: {
        enclosingFunction,
        enclosingClass,
        blockDepth: 0,
        isInTry: false,
        isInCatch: false,
        isInFinally: false,
        isInCallback: false,
        isInPromise: false,
        conditionalDepth,
        loopDepth
      }
    };
  }

  private extractDecoratorArgumentReferences(
    func: any,
    enclosingFunction: string,
    enclosingClass: string | undefined,
    seenAtLine: Set<string>
  ): TSExtractedCall[] {
    const refs: TSExtractedCall[] = [];
    if (this.imports.size === 0) return refs;

    let sibling = func.previousNamedSibling;
    while (sibling && sibling.type === 'decorator') {
      const call = this.findFirst(sibling, 'call_expression');
      const args = call?.childForFieldName('arguments');
      if (args) {
        const identifierNodes = this.collectByType(args, 'identifier');
        for (const idNode of identifierNodes) {
          const ref = this.buildIdentifierReference(idNode, enclosingFunction, enclosingClass, seenAtLine);
          if (ref) refs.push(ref);
        }
      }
      refs.push(...this.extractDecoratorNameReference(sibling, enclosingFunction, enclosingClass, seenAtLine));
      sibling = sibling.previousNamedSibling;
    }

    return refs;
  }

  private extractDecoratorNameReference(
    decoratorNode: any,
    enclosingFunction: string,
    enclosingClass: string | undefined,
    seenAtLine: Set<string>
  ): TSExtractedCall[] {
    const call = this.findFirst(decoratorNode, 'call_expression');
    const calleeNode = call
      ? (call.childForFieldName('function') || call.namedChild(0))
      : this.findFirst(decoratorNode, 'identifier');
    if (!calleeNode || calleeNode.type !== 'identifier') return [];
    if (!this.imports.has(calleeNode.text)) return [];


    const line = calleeNode.startPosition.row + 1;
    const dedupeKey = `${calleeNode.text}:${line}`;
    if (seenAtLine.has(dedupeKey)) return [];
    seenAtLine.add(dedupeKey);

    return [{
      target: calleeNode.text,
      targetType: 'property',
      line,
      column: calleeNode.startPosition.column,
      argumentCount: 0,
      isAsync: false,
      isConditional: false,
      isInLoop: false,
      callExpression: calleeNode.text,
      context: {
        enclosingFunction,
        enclosingClass,
        blockDepth: 0,
        isInTry: false,
        isInCatch: false,
        isInFinally: false,
        isInCallback: false,
        isInPromise: false,
        conditionalDepth: 0,
        loopDepth: 0
      }
    }];
  }

  private isExternalImport(name: string): boolean {
    const info = this.imports.get(name);
    if (!info) return false;
    const source = info.source;
    return !(source.startsWith('.') || source.startsWith('/'));
  }

  private resolveReceiverName(node: any): string | null {
    if (!node) return null;

    switch (node.type) {
      case 'identifier':
        return node.text;
      case 'this':
        return 'this';
      case 'super':
        return 'super';
      case 'import':
        return 'import';

      case 'non_null_expression':
      case 'parenthesized_expression':
      case 'as_expression':
      case 'satisfies_expression':
        return this.resolveReceiverName(node.namedChild(0));
      case 'type_assertion':
        return this.resolveReceiverName(node.namedChild(1));

      case 'member_expression': {
        const base = this.resolveReceiverName(node.childForFieldName('object'));
        if (!base) return null;
        const prop = node.childForFieldName('property');
        if (!prop || prop.type !== 'property_identifier') return null;
        return `${base}.${prop.text}`;
      }
      default:
        return null;
    }
  }

  private extractCall(
    call: any,
    enclosingFunction: string,
    enclosingClass?: string,
    indexed?: TSIndexedCall
  ): TSExtractedCall | null {
    const callee = call.childForFieldName('function') || call.namedChild(0);
    if (!callee) return null;

    let target: string;
    let targetType: TSExtractedCall['targetType'] = 'unknown';

    if (callee.type === 'member_expression') {
      const obj = callee.childForFieldName('object');
      const prop = callee.childForFieldName('property');
      const receiver = this.resolveReceiverName(obj);
      target = `${receiver ?? UNRESOLVED_RECEIVER}.${prop?.text || ''}`;
      targetType = 'method';

      if (receiver && this.isExternalImport(receiver)) {
        targetType = 'library';
      }
    } else if (callee.type === 'identifier') {
      target = callee.text;

      if (this.isExternalImport(target)) {
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
      target = this.resolveReceiverName(callee) ?? UNRESOLVED_RECEIVER;
    }

    const args = call.childForFieldName('arguments');
    const argumentCount = args ? args.namedChildCount : 0;

    const isAsync = indexed?.isAsync ?? call.parent?.type === 'await_expression';
    const { isConditional, conditionalDepth, isInLoop, loopDepth, blockDepth, isInTry, isInCatch, isInFinally, isInCallback, isInPromise } = indexed?.context ?? this.analyzeCallContext(call);

    return {
      target,
      targetType,
      line: call.startPosition.row + 1,
      column: call.startPosition.column,
      argumentCount,
      isAsync,
      isConditional,
      isInLoop,
      callExpression: originalNodeText(this.currentSource, call).substring(0, 100),
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
      if (!node) continue;
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
        const child = node.namedChild(i);
        if (child) stack.push(child);
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

  private extractClasses(root: any, preCollected?: any[], traversal?: TSRootTraversal): TSExtractedClass[] {
    const classes: TSExtractedClass[] = [];
    const classNodes = preCollected ?? this.collectByTypes(root, new Set([
      'class_declaration',
      'abstract_class_declaration',
      'interface_declaration',
      'type_alias_declaration',
    ]));

    for (const cls of classNodes) {
      const extracted = cls.type === 'interface_declaration'
        ? this.extractInterface(cls)
        : cls.type === 'type_alias_declaration'
          ? this.extractTypeAliasShape(cls)
          : this.extractClass(cls, traversal);
      if (extracted) {
        classes.push(extracted);
      }
    }

    return classes;
  }

  private extractClass(cls: any, traversal?: TSRootTraversal): TSExtractedClass | null {
    const nameNode = cls.childForFieldName('name');
    const className = nameNode?.text;
    if (!className) return null;

    let extendsClause: string | undefined;
    let implementsClause: string[] = [];

    const heritage = cls.childForFieldName('heritage') ||
                     this.findFirst(cls, 'class_heritage');

    if (heritage) {
      for (let i = 0, n = heritage.namedChildCount; i < n; i++) {
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
    const decoratorArgs = this.extractDecoratorArgs(cls);
    const documentation = this.extractDocumentation(cls);

    const body = cls.childForFieldName('body');
    const methods: TSExtractedFunction[] = [];
    const properties: TSExtractedProperty[] = [];

    if (body) {
      for (let i = 0, n = body.namedChildCount; i < n; i++) {
        const member = body.namedChild(i);
        if (!member) continue;

        if (member.type === 'method_definition') {
          const method = this.extractFunction(member, traversal?.functions.get(member.id));
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

    const referenceCarrier = methods.find(m => m.type === 'constructor') || methods[0];
    if (referenceCarrier) {
      const classRefs = this.extractClassLevelReferences(cls, heritage, className);
      referenceCarrier.calls.push(...classRefs);
    }

    return {
      name: className,
      kind: 'class',
      extends: extendsClause,
      implements: implementsClause,
      methods,
      properties,
      lineStart: cls.startPosition.row + 1,
      lineEnd: cls.endPosition.row + 1,
      isExported,
      isAbstract,
      decorators,
      decoratorArgs,
      documentation
    };
  }

  private extractClassLevelReferences(cls: any, heritage: any, className: string): TSExtractedCall[] {
    const refs: TSExtractedCall[] = [];
    const seenAtLine = new Set<string>();

    let sibling = cls.previousNamedSibling;
    while (sibling && sibling.type === 'decorator') {
      const call = this.findFirst(sibling, 'call_expression');
      const args = call?.childForFieldName('arguments');
      if (args) {
        for (const idNode of this.collectByType(args, 'identifier')) {
          const ref = this.buildIdentifierReference(idNode, className, className, seenAtLine);
          if (ref) refs.push(ref);
        }
      }
      refs.push(...this.extractDecoratorNameReference(sibling, className, className, seenAtLine));
      sibling = sibling.previousNamedSibling;
    }

    if (heritage) {
      const heritageIdNodes = [
        ...this.collectByType(heritage, 'type_identifier'),
        ...this.collectByType(heritage, 'identifier'),
      ];
      for (const idNode of heritageIdNodes) {
        const ref = this.buildIdentifierReference(idNode, className, className, seenAtLine);
        if (ref) refs.push(ref);
      }
    }

    return refs;
  }

  private extractInterface(intf: any): TSExtractedClass | null {
    const nameNode = intf.childForFieldName('name') || this.findFirst(intf, 'type_identifier');
    const name = nameNode?.text;
    if (!name) return null;

    const body = intf.childForFieldName('body') || this.findFirst(intf, 'interface_body');
    const properties = body ? this.extractTypeShapeProperties(body) : [];

    return {
      name,
      kind: 'interface',
      implements: [],
      methods: [],
      properties,
      lineStart: intf.startPosition.row + 1,
      lineEnd: intf.endPosition.row + 1,
      isExported: intf.parent?.type === 'export_statement',
      isAbstract: false,
      decorators: [],
      documentation: this.extractDocumentation(intf),
    };
  }

  private extractTypeAliasShape(alias: any): TSExtractedClass | null {
    const nameNode = alias.childForFieldName('name') || this.findFirst(alias, 'type_identifier');
    const name = nameNode?.text;
    if (!name) return null;

    const value = alias.childForFieldName('value') || this.findFirst(alias, 'object_type');
    if (!value || value.type !== 'object_type') return null;
    const properties = this.extractTypeShapeProperties(value);
    if (properties.length === 0) return null;

    return {
      name,
      kind: 'type',
      implements: [],
      methods: [],
      properties,
      lineStart: alias.startPosition.row + 1,
      lineEnd: alias.endPosition.row + 1,
      isExported: alias.parent?.type === 'export_statement',
      isAbstract: false,
      decorators: [],
      documentation: this.extractDocumentation(alias),
    };
  }

  private extractTypeShapeProperties(body: any): TSExtractedProperty[] {
    const properties: TSExtractedProperty[] = [];
    const signatures = this.collectByType(body, 'property_signature');
    for (const signature of signatures) {
      const prop = this.extractProperty(signature);
      if (prop) properties.push(prop);
    }
    return properties;
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
    const decoratorArgs = this.extractDecoratorArgs(prop);

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
      decoratorArgs,
      defaultValue
    };
  }

  private extractVariables(root: any, preCollected?: any[], outsideFunctions = false): TSExtractedVariable[] {
    const variables: TSExtractedVariable[] = [];
    const varDeclNodes = preCollected ?? this.collectByTypes(root, new Set(['lexical_declaration', 'variable_declaration']));

    for (const decl of varDeclNodes) {
      if (!outsideFunctions && this.isInsideFunction(decl)) continue;

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

  private extractExports(root: any, preCollected?: any[]): TSExtractedExport[] {
    const exports: TSExtractedExport[] = [];
    const exportNodes = preCollected ?? this.collectByType(root, 'export_statement');

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

  private buildTraversalIndex(root: any): TSRootTraversal {
    const traversal: TSRootTraversal = {
      imports: [],
      classes: [],
      variables: [],
      exports: [],
      comments: [],
      standaloneFunctions: [],
      objectMethods: [],
      functions: new Map()
    };
    const bodyOwners = new Map<any, TSFunctionTraversal>();
    const stack: TSTraversalFrame[] = [{
      node: root,
      parent: null,
      grandparent: null,
      classDepth: 0,
      variableFunctionDepth: 0,
      enclosingFunctionDepth: 0,
      activeFunctions: [],
      throwBoundaries: [],
      conditionalDepth: 0,
      loopDepth: 0,
      blockDepth: 0,
      tryDepth: 0,
      catchDepth: 0,
      finallyDepth: 0,
      callbackDepth: 0,
      promiseDepth: 0
    }];

    while (stack.length > 0) {
      const frame = stack.pop()!;
      const node = frame.node;
      if (!node) continue;
      const type = node.type;

      if (type === 'import_statement') traversal.imports.push(node);
      else if (type === 'class_declaration' || type === 'abstract_class_declaration' ||
               type === 'interface_declaration' || type === 'type_alias_declaration') traversal.classes.push(node);
      else if ((type === 'lexical_declaration' || type === 'variable_declaration') && frame.variableFunctionDepth === 0) traversal.variables.push(node);
      else if (type === 'export_statement') traversal.exports.push(node);

      if (type === 'comment') {
        let commentType = 'line';
        if (node.text.startsWith('/**')) commentType = 'jsdoc';
        else if (node.text.startsWith('/*')) commentType = 'block';
        traversal.comments.push({
          type: commentType,
          text: node.text,
          line: node.startPosition.row + 1
        });
      }

      let functionTraversal: TSFunctionTraversal | undefined;
      if (EXTRACTED_FUNCTION_TYPES.has(type)) {
        functionTraversal = {
          node,
          parent: frame.parent,
          grandparent: frame.grandparent,
          className: frame.className,
          hasEnclosingFunction: frame.enclosingFunctionDepth > 0,
          calls: [],
          identifiers: [],
          complexity: 1,
          throwTypes: new Set()
        };
        traversal.functions.set(node.id, functionTraversal);
        const body = node.childForFieldName('body');
        if (body) bodyOwners.set(body.id, functionTraversal);

        if (frame.classDepth === 0) {
          if (type === 'method_definition') {
            if (frame.parentType === 'object') traversal.objectMethods.push(node);
          } else {
            traversal.standaloneFunctions.push(node);
          }
        }
      }

      const bodyOwner = bodyOwners.get(node.id);
      const activeFunctions = bodyOwner
        ? [...frame.activeFunctions, bodyOwner]
        : frame.activeFunctions;
      const throwBoundaries = THROW_FUNCTION_BOUNDARY_TYPES.has(type)
        ? [...frame.throwBoundaries, functionTraversal]
        : frame.throwBoundaries;

      if (activeFunctions.length > 0) {
        if (type === 'call_expression') {
          const call: TSIndexedCall = {
            node,
            isAsync: frame.parentType === 'await_expression',
            context: {
              isConditional: frame.conditionalDepth > 0,
              isInLoop: frame.loopDepth > 0,
              blockDepth: frame.blockDepth,
              isInTry: frame.tryDepth > 0,
              isInCatch: frame.catchDepth > 0,
              isInFinally: frame.finallyDepth > 0,
              isInCallback: frame.callbackDepth > 0,
              isInPromise: frame.promiseDepth > 0,
              conditionalDepth: frame.conditionalDepth,
              loopDepth: frame.loopDepth
            }
          };
          for (const active of activeFunctions) active.calls.push(call);
        } else if (type === 'identifier') {
          const parent = frame.parent;
          const parentType = frame.parentType;
          let excludeFromReference = parentType === 'import_specifier' ||
            parentType === 'import_clause' || parentType === 'namespace_import';
          if (!excludeFromReference && parent &&
              (parentType === 'call_expression' || parentType === 'new_expression')) {
            excludeFromReference = nodeIdEquals(parent.childForFieldName('function'), node);
          }
          const identifier: TSIndexedIdentifier = {
            node,
            parent,
            excludeFromReference,
            conditionalDepth: frame.conditionalDepth,
            loopDepth: frame.loopDepth
          };
          for (const active of activeFunctions) active.identifiers.push(identifier);
        }

        if (COMPLEXITY_NODE_TYPES.has(type)) {
          let increment = type !== 'binary_expression';
          if (!increment) {
            const operator = node.childForFieldName('operator')?.text;
            increment = operator === '&&' || operator === '||' || operator === '??';
          }
          if (increment) {
            for (const active of activeFunctions) active.complexity++;
          }
        }

        if (type === 'throw_statement') {
          const throwOwner = throwBoundaries[throwBoundaries.length - 1];
          const typeName = throwOwner ? this.throwTypeName(node) : undefined;
          if (typeName && throwOwner) throwOwner.throwTypes.add(typeName);
        }
      }

      let className = frame.className;
      if (CLASS_CONTAINER_TYPES.has(type)) {
        className = node.childForFieldName('name')?.text;
      }

      let promiseDepth = frame.promiseDepth;
      if (type === 'call_expression') {
        const callee = node.childForFieldName('function') || node.namedChild(0);
        if (callee?.text?.includes('then') || callee?.text?.includes('catch')) promiseDepth++;
      }

      const childFrame = {
        classDepth: frame.classDepth + (CLASS_CONTAINER_TYPES.has(type) ? 1 : 0),
        className,
        variableFunctionDepth: frame.variableFunctionDepth + (VARIABLE_FUNCTION_TYPES.has(type) ? 1 : 0),
        enclosingFunctionDepth: frame.enclosingFunctionDepth + (EXTRACTED_FUNCTION_TYPES.has(type) ? 1 : 0),
        activeFunctions,
        throwBoundaries,
        conditionalDepth: frame.conditionalDepth +
          (type === 'if_statement' || type === 'ternary_expression' || type === 'switch_statement' ? 1 : 0),
        loopDepth: frame.loopDepth +
          (type === 'for_statement' || type === 'for_in_statement' || type === 'for_of_statement' ||
           type === 'while_statement' || type === 'do_statement' ? 1 : 0),
        blockDepth: frame.blockDepth + (type === 'statement_block' ? 1 : 0),
        tryDepth: frame.tryDepth + (type === 'try_statement' ? 1 : 0),
        catchDepth: frame.catchDepth + (type === 'catch_clause' ? 1 : 0),
        finallyDepth: frame.finallyDepth + (type === 'finally_clause' ? 1 : 0),
        callbackDepth: frame.callbackDepth + (type === 'arrow_function' || type === 'function_expression' ? 1 : 0),
        promiseDepth
      };

      for (let i = node.namedChildCount - 1; i >= 0; i--) {
        const child = node.namedChild(i);
        if (!child) continue;
        stack.push({
          node: child,
          parent: node,
          grandparent: frame.parent,
          parentType: type,
          ...childFrame
        });
      }
    }

    return traversal;
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
    for (let i = 0, n = node.childCount; i < n; i++) {
      const child = node.child(i);
      if (child?.type === 'async') return true;
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
    return [...this.walkNamedNodes(node)].filter(current => current.type === type);
  }

  private collectByTypes(node: any, types: Set<string>): any[] {
    return [...this.walkNamedNodes(node)].filter(current => types.has(current.type));
  }

  private findFirst(node: any, type: string): any | null {
    for (const current of this.walkNamedNodes(node)) if (current.type === type) return current;
    return null;
  }

  private *walkNamedNodes(node: any): Generator<any> {
    const stack = node ? [node] : [];
    while (stack.length > 0) {
      const current = stack.pop()!;
      yield current;
      for (let i = current.namedChildCount - 1; i >= 0; i--) {
        const child = current.namedChild(i);
        if (child) stack.push(child);
      }
    }
  }
}
