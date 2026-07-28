import * as fs from 'fs';

/**
 * tree-sitter's native scanners treat a literal U+0000 byte as an end-of-input
 * sentinel rather than an ordinary character (confirmed against
 * tree-sitter-typescript: `` `a\0b` `` parses to an ERROR node — `UNEXPECTED '\0'`
 * — even though the construct is valid JS/TS). Several analyzer-core modules
 * deliberately embed a raw NUL as a collision-proof separator inside template
 * literals used for cache/hash keys (e.g. `` `${a}\0${b}` ``); that's legitimate
 * source, not corruption, so it must not be edited. Replace NUL with a
 * same-length, non-NUL placeholder ONLY in the string handed to the parser —
 * the original file content/return value seen by every other caller (hashing,
 * embeddings, display) is untouched. Grammar-general: any parser fed through
 * this module (or wasm-tree-sitter, which reuses this) gets the same
 * treatment regardless of which analyzer's source triggered it.
 */
export function sanitizeForTreeSitterParse(source: string): string {
  return source.indexOf('\0') === -1 ? source : source.replace(/\0/g, '�');
}

/**
 * `abstract` is the one TS modifier keyword this tree-sitter-typescript grammar
 * version (0.23.2) cannot disambiguate from a property/field NAME: unlike
 * `static`/`readonly`/`public`/etc (all fine as property names), a bare
 * `abstract` immediately followed by `:`/`?:` inside an interface body, object
 * type, or class field produces an ERROR node and the grammar then misreads
 * the type annotation's own identifier as the property name (e.g.
 * `abstract?: boolean` extracts a bogus property named "boolean"). Confirmed
 * via minimal repro: `interface X { abstract?: boolean }` -> ERROR;
 * `interface X { static?: boolean }` -> clean. Quoting the key
 * (`"abstract"?: boolean`) is valid TS/JS in every position (interface,
 * object type, object literal) and sidesteps the reserved-word lexing
 * entirely without touching real abstract-modifier usage (`abstract class`,
 * `abstract foo(): void`, both unaffected since neither is followed directly
 * by `:`/`?:`). Only rewrites the string handed to the parser — never the
 * file on disk.
 */
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

const SAVED_ROOT_NODE_DESCRIPTOR = '__klauroSavedRootNodeDescriptor';

/*
 * The tree-sitter JS wrapper replaces Tree.prototype.rootNode with a getter that closes
 * over the original native accessor. When the wrapper is evaluated a second time in the
 * same process through a separate module registry (e.g. two Jest test files in one worker),
 * it destructures the already-replaced getter -- which returns undefined for a prototype
 * receiver -- and redefines the shared native prototype with that captured undefined,
 * breaking rootNode for every module registry in the process. The native Tree prototype is
 * shared process-wide, so we stash the first working descriptor on it and restore it when
 * corruption is detected.
 */
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

/**
 * Deterministic identity comparison for two tree-sitter nodes.
 *
 * The native tree-sitter binding does NOT guarantee a single persistent JS
 * wrapper object per underlying node — repeated accessors (`.parent`,
 * `childForFieldName`, `namedChild`) may hand back freshly-allocated wrappers
 * for the very same node, so `a === b` is unreliable and, worse, its result can
 * differ run-to-run depending on wrapper allocation/GC timing. Every node
 * exposes a stable numeric `id` (the underlying node address) which IS a true
 * identity, so compare on that. Guards against null/undefined so callers can
 * pass a possibly-absent `childForFieldName(...)` result directly.
 */
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

/**
 * One statically-evaluable call argument of a decorator invocation. Positional
 * arguments carry their index as `name` ('0','1',...); named/object-property
 * arguments carry the property key. `value`/`type` are only ever populated for
 * literals we can evaluate without executing code — string, number, boolean,
 * null, and no-substitution template strings. Any non-literal argument
 * (identifier, call, computed object value, spread, template with `${}`) is
 * OMITTED entirely rather than guessed: a downstream consumer that needs an
 * argument it cannot see must fail evidence-gated, never fabricate a value.
 */
export interface TSDecoratorArg {
  name: string;
  value: string | number | boolean | null;
  type: 'string' | 'number' | 'boolean' | 'null';
}

/**
 * A decorator invocation with its literal-evaluable call arguments captured
 * generically for ANY decorator (not just recognized-framework ones). Runs
 * ALONGSIDE the bare `decorators: string[]` name list — the string list is
 * left untouched so every existing `.includes(name)` consumer keeps working;
 * this parallel list is purely additive, and only carries the args we could
 * statically resolve (an empty `args` means the decorator had none we could
 * evaluate, not that it had no arguments).
 */
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
  /** Parallel to `decorators` — same decorators, with their literal-evaluable call args. Additive. */
  decoratorArgs?: TSDecoratorDetail[];
  documentation?: string;
  /**
   * Error TYPE names thrown by `throw new Foo(...)` / `throw Foo(...)` inside this
   * function's body, deduped. Bare re-throws (`throw err`) yield no recoverable type
   * and are intentionally omitted (evidence-gated). Feeds `signature.throws`.
   */
  throws?: string[];
  /**
   * True for a nameless arrow/function-expression callback extracted only to
   * carry its outbound calls (e.g. an Express route handler at module scope).
   * Consumers should NOT emit a graph node for these — they exist so calls made
   * directly inside the callback (fetch/axios) are not silently dropped.
   */
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
  /** Parallel to `decorators` — same decorators, with their literal-evaluable call args. Additive. */
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
  /** Parallel to `decorators` — same decorators, with their literal-evaluable call args. Additive. */
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
  /** 1-indexed line, matching how the rest of this file reports `line`. */
  line: number;
  /** Short, control-character-sanitized preview of the offending text — never the raw slice (which may itself contain the very non-printable bytes that broke parsing, e.g. an embedded NUL). */
  snippet: string;
}

export interface TSFileExtraction {
  imports: TSExtractedImport[];
  functions: TSExtractedFunction[];
  classes: TSExtractedClass[];
  variables: TSExtractedVariable[];
  exports: TSExtractedExport[];
  comments: Array<{ type: string; text: string; line: number }>;
  hasSyntaxErrors: boolean;
  /**
   * WHERE `hasSyntaxErrors` came from, capped and sanitized — additive, so
   * anything reading only the boolean is unaffected. Real tree-sitter ERROR
   * nodes are almost always LOCALIZED (one bad construct, not the whole
   * file): reporting the actual line(s) turns a blanket "this file is
   * broken" warning into an honest, actionable one. Evidence: quality-iter-1
   * #9 traced two "syntax error" flags on real, valid analyzer-core source
   * (cas.types.ts, revision.ts) to (1) `import('m').T[]` — an array-suffixed
   * inline import-type, valid TS that this tree-sitter-typescript grammar
   * version cannot parse — and (2) a literal embedded NUL byte inside a
   * template literal used deliberately as a hash separator, which this
   * grammar's scanner also chokes on. Both are genuine (not a heuristic
   * false positive) but file-level-scary wording overstated the blast
   * radius of a single misparsed token.
   */
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

/** Sanitize a raw tree-sitter node text slice for safe inclusion in a log/warning
 *  string: collapse whitespace runs, escape control characters (including the
 *  literal NUL byte that is itself one of the two known real triggers) so the
 *  message can never itself embed an unprintable/NUL byte, and cap length. */
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

/** Walks the tree collecting up to MAX_SYNTAX_ERROR_LOCATIONS real ERROR/
 *  missing-token node positions. Bounded traversal (stops once the cap is
 *  hit) so a pathologically damaged file can't turn this into an expensive
 *  full-tree walk on every parse. */
export function collectSyntaxErrorLocations(root: any): TSSyntaxErrorLocation[] {
  const locations: TSSyntaxErrorLocation[] = [];
  if (!root) return locations;
  const stack: any[] = [root];
  try {
    while (stack.length > 0 && locations.length < MAX_SYNTAX_ERROR_LOCATIONS) {
      const node = stack.pop();
      if (!node) continue;
      if (node.type === 'ERROR' || node.isMissing) {
        const line = (node.startPosition?.row ?? 0) + 1;
        locations.push({ line, snippet: sanitizeSyntaxErrorSnippet(String(node.text ?? '')) });
        continue; // don't descend into an already-flagged ERROR subtree
      }
      const childCount = node.childCount ?? 0;
      for (let i = childCount - 1; i >= 0; i--) {
        stack.push(node.child(i));
      }
    }
  } catch {
    // Best-effort diagnostics only — never let a traversal failure here mask
    // the underlying hasSyntaxErrors signal, which is computed independently.
  }
  return locations;
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
    const forParse = sanitizeAbstractPropertyKeyword(sanitizeForTreeSitterParse(content));
    const tree = parser.parse(forParse);
    const root = getRootNode(tree);

    // extractImports/Classes/Variables/Exports each independently did a full
    // pre-order DFS of the whole tree to collect their root-level node types —
    // 4 traversals, each marshaling every named node across the native
    // tree-sitter boundary. Collapse them into ONE walk that buckets by type.
    // Because collectByType(s) and this walk use the identical stack/reverse-push
    // order, each type's filtered subsequence is byte-identical to the old
    // per-type walk, so the extract methods produce the same output (proven by
    // node-count equality on hercules-fe).
    const buckets = this.collectRootNodeBuckets(root);
    const hasSyntaxErrors = treeHasSyntaxErrors(root);

    const result: TSFileExtraction = {
      imports: this.extractImports(root, buckets.imports),
      functions: [],
      classes: [],
      variables: [],
      exports: [],
      comments: this.extractComments(root),
      hasSyntaxErrors,
      // Only walk for locations when the boolean is already true — the
      // common case (a healthy file) pays nothing extra.
      syntaxErrorLocations: hasSyntaxErrors ? collectSyntaxErrorLocations(root) : undefined
    };

    const functions = this.extractStandaloneFunctions(root);
    const classes = this.extractClasses(root, buckets.classes);

    for (const cls of classes) {
      result.classes.push(cls);
    }

    for (const fn of functions) {
      if (!fn.className) {
        result.functions.push(fn);
      }
    }

    result.variables = this.extractVariables(root, buckets.variables);
    result.exports = this.extractExports(root, buckets.exports);

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

    // Object-literal shorthand methods (`{ add(a, b) { ... } }`) parse as
    // `method_definition` too, same as class methods, but their parent is an
    // `object` node rather than `class_body`. extractClasses() only walks
    // `class_body` members, so these were falling through entirely: not a
    // "standalone function" (excluded from funcTypes above to avoid
    // double-counting class methods) and not attached to any class. Collect
    // them explicitly here, restricted to method_definitions whose immediate
    // parent is an object literal, so real class methods stay handled solely
    // by extractClasses().
    const objectMethodNodes = this.collectByTypesOutsideClasses(root, new Set(['method_definition']))
      .filter((node: any) => node.parent?.type === 'object');

    for (const func of objectMethodNodes) {
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

    // Nameless arrow/function-expression callbacks passed as call arguments —
    // e.g. an Express route handler `app.get('/orders', (req, res) => { fetch(...) })`
    // — carry no name and would be dropped, taking their outbound calls with
    // them (a server that is also an API client then shows zero exit points).
    // Extract such a callback as an `anonymous` carrier ONLY when it sits at
    // module scope: a callback nested inside another function is already covered
    // because that function's extractCalls() collects the whole subtree, so
    // extracting it here too would double-count the call.
    let isAnonymousCallback = false;
    if (!funcName &&
        (func.type === 'arrow_function' || func.type === 'function_expression') &&
        func.parent?.type === 'arguments' &&
        !this.hasEnclosingFunction(func)) {
      funcName = 'anonymous';
      isAnonymousCallback = true;
    }

    if (!funcName) return null;

    let parent = func.parent;
    while (parent) {
      // `abstract_class_declaration` (a distinct node type from `class_declaration` in
      // tree-sitter-typescript, used for `abstract class X`) needs the same className
      // attribution as a plain class, or every method of every abstract class silently
      // loses its className and gets misfiled as a standalone function.
      if (parent.type === 'class_declaration' || parent.type === 'class' || parent.type === 'abstract_class_declaration') {
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
    const decoratorArgs = this.extractDecoratorArgs(func);
    const calls = this.extractCalls(func, funcName, className);
    const complexity = this.calculateComplexity(func);
    const documentation = this.extractDocumentation(func);
    const throws = this.extractThrows(func);

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

  /**
   * Collect the error TYPE names thrown by `throw` statements in this function's own
   * body. Evidence-gated: only forms where a type is recoverable are emitted —
   *   `throw new Foo(...)`        -> "Foo"     (new_expression constructor)
   *   `throw new errors.Foo(...)` -> "Foo"     (member_expression -> property)
   *   `throw Foo(...)`            -> "Foo"     (call_expression factory, PascalCase only)
   *   `throw err` / `throw e`     -> (skipped, no type recoverable)
   * Nested function/method bodies are NOT descended into (each gets its own scan).
   * Returns undefined when nothing is recoverable so we never emit an empty array.
   */
  private extractThrows(func: any): string[] | undefined {
    const body = func.childForFieldName('body');
    if (!body) return undefined;

    const nestedFnTypes = new Set([
      'function_declaration', 'generator_function_declaration',
      'method_definition', 'arrow_function',
      'function_expression', 'generator_function'
    ]);

    const types = new Set<string>();
    // Manual walk so we can prune nested function bodies (their throws belong to them).
    const stack: any[] = [body];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node !== body && nestedFnTypes.has(node.type)) continue;
      if (node.type === 'throw_statement') {
        const typeName = this.throwTypeName(node);
        if (typeName) types.add(typeName);
      }
      for (let i = node.namedChildCount - 1; i >= 0; i--) {
        stack.push(node.namedChild(i));
      }
    }

    return types.size > 0 ? Array.from(types) : undefined;
  }

  /** Extract the error type name from a `throw_statement`, or undefined if none is recoverable. */
  private throwTypeName(throwStmt: any): string | undefined {
    // The thrown value is the first (and only) named child of `throw_statement`.
    const expr = throwStmt.namedChild(0);
    if (!expr) return undefined;

    if (expr.type === 'new_expression') {
      const ctor = expr.childForFieldName('constructor');
      return this.identifierTail(ctor);
    }

    if (expr.type === 'call_expression') {
      // Factory form `throw makeError()` — only treat as a type when the callee is
      // PascalCase (looks like a constructor/error factory), to avoid lifting plain
      // helper calls like `throw buildResponse()`.
      const callee = expr.childForFieldName('function');
      const name = this.identifierTail(callee);
      if (name && /^[A-Z]/.test(name)) return name;
      return undefined;
    }

    // `throw err`, `throw obj.field`, string/object literals — no error TYPE to record.
    return undefined;
  }

  /** Resolve `identifier` directly or the trailing `property` of a `member_expression`. */
  private identifierTail(node: any): string | undefined {
    if (!node) return undefined;
    if (node.type === 'identifier') return node.text;
    if (node.type === 'member_expression') {
      return node.childForFieldName('property')?.text;
    }
    return undefined;
  }

  /** Whether `node` is lexically nested inside any function-like ancestor. */
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

    // Compare by stable node id, not object identity — `.parent` may return a
    // freshly-allocated wrapper for the same node, making `===` nondeterministic
    // across processes (see nodeIdEquals). A spurious mismatch here would drop
    // the return type run-to-run.
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

  // Structured counterpart to extractDecorators: the SAME decorators, but each paired with
  // the call arguments we can STATICALLY EVALUATE. This exists so a custom decorator
  // (`@Endpoint('/orders','GET')`) carries its literal path/method the same way a
  // recognized-framework decorator does — the bare-name list alone (extractDecorators)
  // gave downstream consumers (buildAllDecorators -> CASDecorator.parameters -> the
  // `.klaurorc` conventions applier) nothing to resolve a declared route's args from, so
  // they correctly refused to emit a route. We only surface args we can evaluate WITHOUT
  // running code (string/number/boolean/null/no-substitution template); anything else is
  // omitted, never guessed — evidence-first, same discipline as the reference scan above.
  //
  // tree-sitter places a decorator differently by target: on a method/property it is a
  // PREVIOUS NAMED SIBLING, but on a class_declaration it is a DIRECT CHILD (`decorator`
  // before the `class` token). We walk both so class-level decorator args resolve too —
  // extractDecorators (bare names) only ever looks at previous siblings, so class-level
  // NAMES are a known pre-existing gap there; here we cover both placements.
  private extractDecoratorArgs(node: any): TSDecoratorDetail[] {
    const details: TSDecoratorDetail[] = [];

    const decoratorNodes: any[] = [];
    // Class-level decorators sit as leading children of the declaration node.
    for (const child of node.namedChildren || []) {
      if (child.type === 'decorator') decoratorNodes.push(child);
      else break; // decorators only ever lead; stop at the first non-decorator child.
    }
    // Method/property decorators sit as preceding siblings (collected in source order).
    const siblingDecorators: any[] = [];
    let sibling = node.previousNamedSibling;
    while (sibling && sibling.type === 'decorator') {
      siblingDecorators.unshift(sibling);
      sibling = sibling.previousNamedSibling;
    }
    decoratorNodes.push(...siblingDecorators);

    for (const decoratorNode of decoratorNodes) {
      const call = this.findFirst(decoratorNode, 'call_expression');
      // Bare `@Foo` with no call: record the name with no args (mirrors extractDecorators).
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

            // Object argument (`@Foo({ path: '/p', method: 'GET' })`): each key/value
            // pair whose value is a literal becomes a named entry keyed by the property.
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

            // Positional argument: only kept when the expression is a literal we can
            // evaluate. A skipped non-literal still consumes its positional index so the
            // remaining args keep their true call-site positions (a consumer selecting
            // `arg[2]` must not silently shift onto `arg[3]`).
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

  // The property key of an object-literal `pair`. Handles both `path:` (property_identifier)
  // and `'path':` / `"path":` (string) forms; a computed key (`[expr]:`) is not statically
  // resolvable and yields undefined so the whole pair is skipped.
  private decoratorObjectKey(keyNode: any): string | undefined {
    if (!keyNode) return undefined;
    if (keyNode.type === 'property_identifier') return keyNode.text;
    if (keyNode.type === 'string') {
      const evaluated = this.evaluateLiteralNode(keyNode);
      return evaluated && typeof evaluated.value === 'string' ? evaluated.value : undefined;
    }
    return undefined;
  }

  // Statically evaluate a single expression node to a literal value, or return undefined
  // when it is not a literal we can resolve without executing code. Intentionally narrow:
  // string, number, boolean, null, and template strings with NO `${}` substitution. An
  // identifier, call, member access, spread, binary expression, or a template carrying a
  // substitution all return undefined — the caller drops them rather than fabricating.
  private evaluateLiteralNode(node: any): { value: string | number | boolean | null; type: TSDecoratorArg['type'] } | undefined {
    if (!node) return undefined;
    switch (node.type) {
      case 'string': {
        // A `string` node wraps `string_fragment` child(ren) plus quote tokens; empty
        // string has no fragment. Concatenate fragments (escapes are left as written —
        // we surface the source text, not a re-parsed runtime value).
        const fragments = node.namedChildren
          .filter((c: any) => c.type === 'string_fragment' || c.type === 'escape_sequence')
          .map((c: any) => c.text);
        return { value: fragments.join(''), type: 'string' };
      }
      case 'template_string': {
        // Only a substitution-free template is a static string literal.
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

  private extractCalls(func: any, enclosingFunction: string, enclosingClass?: string): TSExtractedCall[] {
    const calls: TSExtractedCall[] = [];
    const body = func.childForFieldName('body');
    if (!body) return calls;

    // extractCalls walked the body for call_expression and then
    // extractIdentifierReferences walked the SAME body again for identifier —
    // two full DFS per function body across the native tree-sitter boundary.
    // Do ONE walk that buckets both types (identifiers only when there are
    // imports, matching extractIdentifierReferences' early-return so no extra
    // work when it would be a no-op). Same pre-order DFS => same node order in
    // each bucket, and calls are still emitted before identifier refs, so
    // output is byte-identical.
    const needIdentifiers = this.imports.size > 0;
    const callNodes: any[] = [];
    const identifierNodes: any[] = [];
    {
      const stack = [body];
      while (stack.length > 0) {
        const current = stack.pop()!;
        const t = current.type;
        if (t === 'call_expression') callNodes.push(current);
        else if (needIdentifiers && t === 'identifier') identifierNodes.push(current);
        for (let i = current.namedChildCount - 1; i >= 0; i--) {
          stack.push(current.namedChild(i));
        }
      }
    }

    for (const call of callNodes) {
      const extracted = this.extractCall(call, enclosingFunction, enclosingClass);
      if (extracted) {
        calls.push(extracted);
      }
    }

    const seenAtLine = new Set<string>();
    calls.push(...this.extractIdentifierReferences(body, enclosingFunction, enclosingClass, seenAtLine, identifierNodes));

    // Decorators on this method itself (e.g. `@InternalGet('x', [...ERRORS])` on a
    // route handler) sit as a sibling of `func`, not inside its `body`, so the scan
    // above never reaches identifiers used in decorator call arguments. Method-level
    // decorators are already in scope for this function's call list, so fold their
    // argument references in here directly. See extractDecoratorArgumentReferences
    // for why this closes a real, previously-invisible reference-miss class.
    calls.push(...this.extractDecoratorArgumentReferences(func, enclosingFunction, enclosingClass, seenAtLine));

    return calls;
  }

  // Cross-file reads of an imported CONSTANT / INTERFACE / TYPE / CLASS that are never
  // called — e.g. `TIER_RATE_LIMITS[tier]`, `return limits.endpoints`. Plain
  // extractCalls only ever fires on call_expression/new_expression, so a bare read of an
  // imported const/object was previously invisible to the call graph even though the
  // consumer genuinely breaks if the export's shape changes (the #1 flagship gap from the
  // 2026-07-04 impact benchmark: get_callers on an exported const/interface property
  // returned nothing beyond same-file containment). Recorded with targetType 'property'
  // (distinct from 'function'/'method'/'constructor') so the CAS integration layer can
  // emit a 'references' edge instead of a 'calls' edge — never claiming a call that never
  // happened. Deliberately conservative: only fires for identifiers present in this
  // file's import map, so a same-named local variable is never mistaken for a cross-file
  // reference (no fabricated edges).
  private extractIdentifierReferences(
    body: any,
    enclosingFunction: string,
    enclosingClass: string | undefined,
    seenAtLine: Set<string>,
    preCollected?: any[]
  ): TSExtractedCall[] {
    const refs: TSExtractedCall[] = [];
    if (this.imports.size === 0) return refs;

    const identifierNodes = preCollected ?? this.collectByType(body, 'identifier');

    for (const idNode of identifierNodes) {
      const ref = this.buildIdentifierReference(idNode, enclosingFunction, enclosingClass, seenAtLine);
      if (ref) refs.push(ref);
    }

    return refs;
  }

  // Shared per-identifier-node reference builder used by both the function-body scan
  // (extractIdentifierReferences) and the decorator-argument scan
  // (extractDecoratorArgumentReferences) so the exclusion rules, de-dupe key, and
  // conditional/loop-depth walk stay in exactly one place. Returns null for anything
  // that isn't a genuine cross-file read of an imported binding (never fabricates).
  private buildIdentifierReference(
    idNode: any,
    enclosingFunction: string,
    enclosingClass: string | undefined,
    seenAtLine: Set<string>
  ): TSExtractedCall | null {
    const name = idNode.text;
    if (!this.imports.has(name)) return null;

    const parent = idNode.parent;
    if (!parent) return null;

    // Already captured as a real call/constructor edge by extractCall/extractCalls —
    // don't double-record the same site as a 'reference' too.
    //
    // Compare tree-sitter nodes by their stable numeric `id`, NOT by object
    // identity (`===`). The native binding does not guarantee a single persistent
    // JS wrapper per underlying node: a fresh access (here `childForFieldName`)
    // can return a newly-allocated wrapper for the same node, so `===` is
    // nondeterministic across processes (it depends on wrapper GC/allocation
    // timing). When `===` spuriously fails on a genuine call callee, the call
    // site leaks in as a bogus `references` edge, flipping the edge set run-to-run
    // (Camp-B determinism defect). `id` is the underlying node identity and is
    // stable, so this exclusion is now deterministic. See `nodeIdEquals`.
    if (parent.type === 'call_expression' && nodeIdEquals(parent.childForFieldName('function'), idNode)) return null;
    if (parent.type === 'new_expression' && nodeIdEquals(parent.childForFieldName('function'), idNode)) return null;
    // Import specifier / declaration positions are bindings, not reads.
    if (parent.type === 'import_specifier' || parent.type === 'import_clause' ||
        parent.type === 'namespace_import') return null;

    // De-dupe multiple identifier occurrences resolving to the same import at the same
    // source line (e.g. `TIER_RATE_LIMITS[tier] || TIER_RATE_LIMITS.free` on one line) —
    // one reference edge per line is enough signal without inflating counts.
    const line = idNode.startPosition.row + 1;
    const dedupeKey = `${name}:${line}`;
    if (seenAtLine.has(dedupeKey)) return null;
    seenAtLine.add(dedupeKey);

    let parentNode = idNode.parent;
    let conditionalDepth = 0;
    let loopDepth = 0;
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

  // Decorators (`@InternalGet('x', [[200, Y], ...INTERNAL_GET_ERRORS])`,
  // `@Module({ providers: [...], })`, ...) sit as `decorator` siblings immediately
  // before the function/class/property they annotate — tree-sitter does NOT nest them
  // inside that node's `body`/`class_body`, so identifiers referenced in decorator
  // arguments (e.g. a spread-imported error-list constant, or a DI token array element)
  // were entirely invisible to the reference/call graph. Measured on a benchmarked NestJS API: a
  // decorator-array-spread constant resolved 1/18 real consumers before this fix
  // (every site was a decorator argument). Only decorator ARGUMENTS are scanned here —
  // the decorator's own callee name (e.g. `AllowAnonymous` in `@AllowAnonymous()`) is
  // handled separately by extractDecoratorNameReferences so a same-named local isn't
  // conflated and so decorator-as-annotation vs decorator-argument stay distinguishable
  // in the evidence trail.
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

  // The decorator invocation itself (`@AllowAnonymous()`, `@InternalGet(...)`) is a
  // genuine cross-file usage of the imported decorator factory/function — e.g.
  // `AllowAnonymous` re-exported through a barrel (`@<scope>/auth`) and applied to 23
  // route handlers project-wide resolved 0/23 before this fix, because extractDecorators
  // only ever kept the bare name string for display, never fed it through the
  // identifier-reference path. Recorded the same conservative way as a bare read
  // (targetType 'property', not 'calls') since a decorator is compile-time metadata
  // attachment, not a runtime call — never claim a call that doesn't happen.
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

    // buildIdentifierReference() normally skips an identifier whose parent is a
    // call_expression function position, to avoid double-recording a real function
    // call already captured by extractCall/extractCalls as a 'calls' edge. A decorator
    // invocation (`@Controller()`) is NEVER walked by extractCall (extractCalls only
    // ever collects call_expression nodes reachable from a function BODY, and
    // decorators sit outside every body), so there is no real 'calls' edge here to
    // collide with — bypass that specific exclusion by building the reference
    // directly instead of routing through buildIdentifierReference's parent check.
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

  // True only when `name` is imported from a genuine external package (bare specifier, no
  // leading `.`/`/`), not a same-project relative import. A same-project import (e.g.
  // `import { initializeAuth0Token } from '../api/fetch'`) must still resolve through the
  // normal call-graph name resolver (findNodeIdByNameIndexed) so get_callers can find it —
  // see bug #2 in the 2026-07-04 impact benchmark.
  private isExternalImport(name: string): boolean {
    const info = this.imports.get(name);
    if (!info) return false;
    const source = info.source;
    return !(source.startsWith('.') || source.startsWith('/'));
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

      // Only classify as a 'library' (external SDK) call when the import source is a real
      // package, not a same-project relative import (e.g. `import { x } from '../api/y'`).
      // Without this check, any call through an object imported from ANYWHERE — including
      // this project's own modules — was routed to the external/exit-point branch instead
      // of resolving to a real 'calls' edge, which is bug #2 from the 2026-07-04 impact
      // benchmark (get_callers inconsistently missing cross-file calls to imported
      // functions/objects that happen to be local, not third-party).
      if (obj?.text && this.isExternalImport(obj.text)) {
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

  private extractClasses(root: any, preCollected?: any[]): TSExtractedClass[] {
    const classes: TSExtractedClass[] = [];
    // `abstract class Foo extends Base` parses as `abstract_class_declaration`, a
    // DIFFERENT node type from plain `class_declaration` in tree-sitter-typescript —
    // discovered while diagnosing the callers-completeness gap (an abstract base class
    // like a benchmarked NestJS API's AgentAccessServiceBase/CheckAccess/AccessMutation chain was
    // invisible to extractClasses entirely, not just to reference resolution). Include
    // it here so abstract classes get nodes, methods, heritage, and (via
    // extractClassLevelReferences) reference edges at all.
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
          : this.extractClass(cls);
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

    // Class-level cross-file reads that have no natural enclosing function of their
    // own: the class decorator (`@Module({ providers: [...], inject: [EventBusService] })`,
    // `@Controller()`) and the heritage clause (`class Foo extends Base implements I`).
    // Both sit outside every method's body, so extractCalls()/extractIdentifierReferences
    // never see them. There is no graph node for "the class's decorator" or "the class's
    // heritage" in isolation, so — same device already used for anonymous-callback exit
    // points (see resolveAnonymousContainerNodeIdIndexed in the framework analyzer) —
    // attribute these reads to the constructor if one exists, else the first extracted
    // method, so they ride along on a node that genuinely gets indexed. If the class has
    // no methods at all, the references are dropped rather than fabricating a carrier.
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

  // Identifier references that belong to the class as a whole rather than to any one
  // method: the class decorator's arguments/name (@Module/@Controller/...) and the
  // heritage clause's type identifiers (`extends Base`, `implements I1, I2`). Heritage
  // uses `type_identifier` nodes, not `identifier` — a distinct node type the body scan
  // never looks for, and one that sits outside any method body regardless. Measured on
  // a benchmarked NestJS API: `class CheckAccess extends AgentAccessServiceBase` produced ZERO
  // resolvable references before this fix (0 decl candidates even), because the base
  // class was never linked as a read of the imported binding.
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
      // `implements Foo` types parse as `type_identifier`, but `extends Base` parses
      // Base as a plain `identifier` (JS/TS grammar treats the extends target as a
      // value-position expression, not a type) — both node types appear under
      // class_heritage depending on which clause, so both must be scanned or a plain
      // `extends Base` (the common case) resolves nothing at all.
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

  private extractVariables(root: any, preCollected?: any[]): TSExtractedVariable[] {
    const variables: TSExtractedVariable[] = [];
    const varDeclNodes = preCollected ?? this.collectByTypes(root, new Set(['lexical_declaration', 'variable_declaration']));

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
    for (let i = 0, n = node.childCount; i < n; i++) {
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

  /**
   * Single-pass root collector: one pre-order DFS that buckets the four
   * root-level node categories that extractImports/Classes/Variables/Exports
   * used to each walk the whole tree for. The stack/reverse-push order is
   * identical to collectByType(s), so each bucket equals the corresponding
   * per-type walk exactly (same nodes, same document order).
   */
  private collectRootNodeBuckets(root: any): {
    imports: any[];
    classes: any[];
    variables: any[];
    exports: any[];
  } {
    const imports: any[] = [];
    const classes: any[] = [];
    const variables: any[] = [];
    const exports: any[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const t = current.type;
      if (t === 'import_statement') imports.push(current);
      else if (t === 'class_declaration' || t === 'abstract_class_declaration' || t === 'interface_declaration' || t === 'type_alias_declaration') classes.push(current);
      else if (t === 'lexical_declaration' || t === 'variable_declaration') variables.push(current);
      else if (t === 'export_statement') exports.push(current);
      for (let i = current.namedChildCount - 1; i >= 0; i--) {
        stack.push(current.namedChild(i));
      }
    }
    return { imports, classes, variables, exports };
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
      if (current !== node && (current.type === 'class_declaration' || current.type === 'class' || current.type === 'abstract_class_declaration')) {
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
    for (let i = 0, n = node.namedChildCount; i < n; i++) {
      const found = this.findFirst(node.namedChild(i), type);
      if (found) return found;
    }
    return null;
  }
}
