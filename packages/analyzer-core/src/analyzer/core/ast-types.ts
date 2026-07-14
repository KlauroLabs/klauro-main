export interface ASTParserResult {
  success: boolean;
  ast?: any;
  error?: string;
}

export interface GoASTNode {
  type: string;
  name?: string;
  package?: string;
  receiver?: {
    name: string;
    type: string;
    pointer: boolean;
  };
  params?: Array<{ name: string; type: string }>;
  returns?: string[];
  calls?: Array<{
    package?: string;
    function: string;
    line: number;
    column: number;
  }>;
  imports?: Array<{
    path: string;
    alias?: string;
  }>;
  fields?: Array<{
    name: string;
    type: string;
    tag?: string;
  }>;
  methods?: Array<{
    name: string;
    receiver?: string;
  }>;
  position?: {
    file: string;
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
  };
  children?: GoASTNode[];
}

export interface RustASTNode {
  kind: string;
  name?: string;
  visibility?: string;
  attributes?: string[];
  generics?: string[];
  parameters?: Array<{ name: string; type: string }>;
  returnType?: string;
  calls?: Array<{
    module?: string;
    function: string;
    line: number;
  }>;
  uses?: Array<{
    path: string;
    alias?: string;
  }>;
  fields?: Array<{
    name: string;
    type: string;
    visibility: string;
  }>;
  methods?: Array<{
    name: string;
    selfParam?: string;
  }>;
  span?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  children?: RustASTNode[];
}

export interface CSharpASTNode {
  kind: string;
  name?: string;
  namespace?: string;
  modifiers?: string[];
  baseTypes?: string[];
  parameters?: Array<{ name: string; type: string; modifiers?: string[] }>;
  returnType?: string;
  invocations?: Array<{
    target?: string;
    method: string;
    line: number;
  }>;
  usings?: Array<{
    namespace: string;
    alias?: string;
  }>;
  members?: Array<{
    kind: string;
    name: string;
    type?: string;
    modifiers?: string[];
  }>;
  location?: {
    file: string;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
  };
  children?: CSharpASTNode[];
}

export interface PHPASTNode {
  nodeType: string;
  name?: string;
  namespace?: string;
  visibility?: string;
  modifiers?: string[];
  extends?: string;
  implements?: string[];
  parameters?: Array<{
    name: string;
    type?: string;
    default?: string;
    byRef?: boolean;
    variadic?: boolean;
  }>;
  returnType?: string;
  calls?: Array<{
    class?: string;
    method?: string;
    function?: string;
    /** Receiver variable for a member call `$recv->method()` (without `$`). */
    receiver?: string;
    line: number;
    /** True when the call site sits inside an if/elseif/else/switch/case/
     *  match/ternary construct within its enclosing function — the
     *  deterministic ground for a 'branch' step-graph edge (evidence: the
     *  call expression's tree-sitter ancestor chain contains a conditional
     *  node type). Absent (not `false`) when there is no such ancestor. */
    isConditional?: boolean;
  }>;
  uses?: Array<{
    name: string;
    alias?: string;
  }>;
  properties?: Array<{
    name: string;
    type?: string;
    visibility?: string;
    static?: boolean;
  }>;
  methods?: Array<{
    name: string;
    visibility?: string;
    static?: boolean;
    abstract?: boolean;
  }>;
  attributes?: {
    startLine: number;
    endLine: number;
    startFilePos?: number;
    endFilePos?: number;
  };
  children?: PHPASTNode[];
}

export interface TypeScriptASTNode {
  kind: string;
  name?: string;
  className?: string;
  isAsync?: boolean;
  isExported?: boolean;
  decorators?: string[];
  parameters?: Array<{
    name: string;
    type?: string;
    optional?: boolean;
  }>;
  returnType?: string;
  calls?: Array<{
    target?: string;
    method: string;
    line: number;
    isAsync?: boolean;
  }>;
  imports?: Array<{
    source: string;
    specifiers: Array<{ name: string; alias?: string }>;
    isDefault?: boolean;
    isNamespace?: boolean;
  }>;
  properties?: Array<{
    name: string;
    type?: string;
    visibility?: string;
    isStatic?: boolean;
    isReadonly?: boolean;
  }>;
  methods?: Array<{
    name: string;
    isAsync?: boolean;
    visibility?: string;
    isStatic?: boolean;
  }>;
  location?: {
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
  };
  children?: TypeScriptASTNode[];
}
