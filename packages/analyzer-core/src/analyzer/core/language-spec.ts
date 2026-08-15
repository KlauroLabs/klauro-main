
export interface LanguageSpec {
  grammar: string;
  functionNodeTypes: string[];
  classNodeTypes: string[];
  classNodeLabel?: string;
  aggregateClassNodes?: boolean;
  callNodeTypes: string[];
  importNodeTypes: string[];
  importCallNames?: string[];
  nameField?: string;
  resolveName?: (node: any) => string;
  declFilter?: (node: any) => boolean;
  resolveCallee?: (node: any) => string;
}

function firstNamed(node: any): any {
  return node.namedChildCount > 0 ? node.namedChild(0) : null;
}

function lispIsDef(node: any, prefixes: string[]): boolean {
  const head = firstNamed(node);
  const t = head?.type || '';
  if (!/sym|symbol/.test(t)) return false;
  const txt = head.text || '';
  return prefixes.some(p => txt === p || txt.startsWith(p));
}

function firstDescByType(node: any, type: string, depth = 0): string {
  if (depth > 6) return '';
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === type) return c.text;
    const r = firstDescByType(c, type, depth + 1);
    if (r) return r;
  }
  return '';
}

function lispDefName(node: any): string {
  if (node.namedChildCount < 2) return '';
  const second = node.namedChild(1);
  const t = second?.type || '';
  if (/list/.test(t)) return firstNamed(second)?.text || '';
  return second?.text || '';
}

function mlirOpKeyword(node: any): string {
  let co = node;
  if (co?.type === 'operation') co = co.namedChildCount > 0 ? co.namedChild(0) : null;
  const dialect = co && co.type === 'custom_operation' && co.namedChildCount > 0 ? co.namedChild(0) : null;
  if (!dialect || dialect.childCount === 0) return '';
  return dialect.child(0)?.type || '';
}

export const LANGUAGE_SPECS: Record<string, LanguageSpec> = {
  lua: {
    grammar: 'lua',
    functionNodeTypes: ['function_definition_statement', 'local_function_definition_statement', 'function_definition', 'function_declaration'],
    classNodeTypes: [],
    callNodeTypes: ['call', 'function_call'],
    importNodeTypes: [],
    importCallNames: ['require'],
    resolveName: (node: any) => node.namedChild?.(0)?.text || '',
  },
  scala: {
    grammar: 'scala',
    functionNodeTypes: ['function_definition', 'function_declaration'],
    classNodeTypes: ['class_definition', 'object_definition', 'trait_definition'],
    callNodeTypes: ['call_expression', 'generic_function'],
    importNodeTypes: ['import_declaration'],
    nameField: 'name',
  },
  rescript: {
    grammar: 'rescript',
    functionNodeTypes: ['let_binding'],
    classNodeTypes: [],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['open_statement', 'module_declaration'],
    nameField: 'name',
  },
  zig: {
    grammar: 'zig',
    functionNodeTypes: ['function_declaration'],
    classNodeTypes: [],
    callNodeTypes: ['call_expression'],
    importNodeTypes: [],
    nameField: 'name',
  },
  erlang: {
    grammar: 'erlang',
    functionNodeTypes: ['fun_decl'],
    classNodeTypes: [],
    callNodeTypes: ['call'],
    importNodeTypes: [],
  },
  gleam: {
    grammar: 'gleam',
    functionNodeTypes: ['function'],
    classNodeTypes: ['type_definition'],
    callNodeTypes: ['function_call'],
    importNodeTypes: ['import'],
  },
  fortran: {
    grammar: 'fortran',
    functionNodeTypes: ['subroutine', 'function'],
    classNodeTypes: ['module', 'derived_type_definition'],
    callNodeTypes: ['subroutine_call', 'call_expression'],
    importNodeTypes: ['use_statement'],
  },
  elm: {
    grammar: 'elm',
    functionNodeTypes: ['value_declaration'],
    classNodeTypes: ['type_declaration', 'type_alias_declaration'],
    callNodeTypes: ['function_call_expr'],
    importNodeTypes: ['import_clause'],
  },
  ada: {
    grammar: 'ada',
    functionNodeTypes: ['subprogram_body'],
    classNodeTypes: ['package_declaration', 'package_body'],
    callNodeTypes: ['procedure_call_statement', 'function_call'],
    importNodeTypes: ['with_clause'],
  },
  objc: {
    grammar: 'objc',
    functionNodeTypes: ['method_definition', 'function_definition'],
    classNodeTypes: ['class_implementation', 'class_interface'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['preproc_import', 'module_import'],
  },
  perl: {
    grammar: 'perl',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: [],
    callNodeTypes: ['call_expression_with_args_with_brackets'],
    importNodeTypes: ['use_statement'],
  },
  odin: {
    grammar: 'odin',
    functionNodeTypes: ['procedure_declaration'],
    classNodeTypes: ['struct_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_declaration'],
  },
  pascal: {
    grammar: 'pascal',
    functionNodeTypes: ['defProc'],
    classNodeTypes: ['defType'],
    callNodeTypes: ['exprCall'],
    importNodeTypes: ['declUses'],
  },
  proto: {
    grammar: 'proto',
    functionNodeTypes: ['rpc'],
    classNodeTypes: ['service', 'message'],
    callNodeTypes: [],
    importNodeTypes: ['import'],
  },
  glsl: {
    grammar: 'glsl',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['struct_specifier'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['preproc_include'],
  },
  hlsl: {
    grammar: 'hlsl',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['struct_specifier', 'class_specifier'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['preproc_include'],
  },
  cmake: {
    grammar: 'cmake',
    functionNodeTypes: ['function_def', 'macro_def'],
    classNodeTypes: [],
    callNodeTypes: ['normal_command'],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'unquoted_argument'),
  },
  verilog: {
    grammar: 'verilog',
    functionNodeTypes: ['task_declaration', 'function_declaration'],
    classNodeTypes: ['module_declaration', 'class_declaration'],
    callNodeTypes: [],
    importNodeTypes: ['package_import_declaration'],
    resolveName: (node: any) => firstDescByType(node, 'simple_identifier'),
  },
  groovy: {
    grammar: 'groovy',
    functionNodeTypes: ['method_declaration', 'function_definition'],
    classNodeTypes: ['class_declaration'],
    callNodeTypes: ['method_invocation'],
    importNodeTypes: ['import_declaration'],
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  powershell: {
    grammar: 'powershell',
    functionNodeTypes: ['function_statement'],
    classNodeTypes: ['class_statement'],
    callNodeTypes: ['command'],
    importNodeTypes: [],
  },
  d: {
    grammar: 'd',
    functionNodeTypes: ['function_declaration'],
    classNodeTypes: ['class_declaration', 'struct_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_declaration'],
  },
  commonlisp: {
    grammar: 'commonlisp',
    functionNodeTypes: ['defun'],
    classNodeTypes: [],
    callNodeTypes: ['list_lit'],
    importNodeTypes: [],
    resolveName: (node: any) => {
      const header = firstNamed(node);
      if (!header) return '';
      for (let i = 0; i < header.namedChildCount; i++) {
        const c = header.namedChild(i);
        if (c?.type === 'sym_lit') return c.text;
      }
      return '';
    },
  },
  scheme: {
    grammar: 'scheme',
    functionNodeTypes: ['list'],
    classNodeTypes: [],
    callNodeTypes: ['list'],
    importNodeTypes: [],
    declFilter: (node: any) => lispIsDef(node, ['define', 'defun']),
    resolveName: lispDefName,
  },
  racket: {
    grammar: 'racket',
    functionNodeTypes: ['list'],
    classNodeTypes: [],
    callNodeTypes: ['list'],
    importNodeTypes: [],
    declFilter: (node: any) => lispIsDef(node, ['define', 'defun']),
    resolveName: lispDefName,
  },
  r: {
    grammar: 'r',
    functionNodeTypes: ['binary_operator'],
    classNodeTypes: [],
    callNodeTypes: ['call'],
    importNodeTypes: [],
    importCallNames: ['library', 'require', 'requireNamespace', 'loadNamespace'],
    declFilter: (node: any) => {
      for (let i = 0; i < node.namedChildCount; i++) {
        if (node.namedChild(i)?.type === 'function_definition') return true;
      }
      return false;
    },
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  vhdl: {
    grammar: 'vhdl',
    functionNodeTypes: ['process_statement', 'subprogram_body', 'subprogram_definition'],
    classNodeTypes: ['architecture_definition', 'entity_declaration', 'package_declaration', 'package_definition'],
    callNodeTypes: ['procedure_call', 'procedure_call_statement'],
    importNodeTypes: ['library_clause', 'use_clause'],
    resolveName: (node: any) => {
      const id = firstDescByType(node, 'identifier');
      if (id) return id;
      const label = firstDescByType(node, 'label_declaration') ||
        (node.namedChildCount > 0 ? node.namedChild(0)?.text || '' : '');
      return label.replace(/\s*:\s*$/, '').trim();
    },
  },
  haskell: {
    grammar: 'haskell',
    functionNodeTypes: ['function'],
    classNodeTypes: ['data_type', 'class_declaration'],
    callNodeTypes: ['apply'],
    importNodeTypes: ['import'],
    nameField: 'name',
  },
  nix: {
    grammar: 'nix',
    functionNodeTypes: ['binding'],
    classNodeTypes: [],
    callNodeTypes: ['apply_expression'],
    importNodeTypes: [],
  },
  jsonnet: {
    grammar: 'jsonnet',
    functionNodeTypes: ['field'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: ['importstr', 'import'],
  },
  gdscript: {
    grammar: 'gdscript',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['class_definition'],
    callNodeTypes: ['call'],
    importNodeTypes: [],
    nameField: 'name',
  },
  starlark: {
    grammar: 'starlark',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: [],
    callNodeTypes: ['call'],
    importNodeTypes: [],
    importCallNames: ['load'],
    nameField: 'name',
  },
  slang: {
    grammar: 'slang',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['struct_specifier', 'class_specifier'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['preproc_include', 'import_declaration'],
  },
  ocaml: {
    grammar: 'ocaml',
    functionNodeTypes: ['let_binding'],
    classNodeTypes: ['module_definition', 'type_definition'],
    callNodeTypes: ['application_expression'],
    importNodeTypes: ['open_module'],
  },
  nickel: {
    grammar: 'nickel',
    functionNodeTypes: ['let_binding'],
    classNodeTypes: [],
    callNodeTypes: ['applicative'],
    importNodeTypes: [],
  },
  agda: {
    grammar: 'agda',
    functionNodeTypes: ['function'],
    classNodeTypes: ['module'],
    callNodeTypes: [],
    importNodeTypes: ['import'],
  },
  json: {
    grammar: 'json',
    functionNodeTypes: ['pair'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => {
      const k = node.namedChild?.(0);
      if (k?.type !== 'string') return '';
      const sc = k.namedChild?.(0);
      return sc?.type === 'string_content' ? sc.text : '';
    },
  },
  toml: {
    grammar: 'toml',
    functionNodeTypes: ['pair'],
    classNodeTypes: ['table', 'table_array_element'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) =>
      firstDescByType(node, 'dotted_key') || firstDescByType(node, 'bare_key'),
  },
  css: {
    grammar: 'css',
    functionNodeTypes: [],
    classNodeTypes: ['rule_set'],
    classNodeLabel: 'style_rule',
    aggregateClassNodes: true,
    callNodeTypes: [],
    importNodeTypes: ['import_statement'],
    resolveName: (node: any) => firstDescByType(node, 'selectors').replace(/\s+/g, ' ').trim(),
  },
  html: {
    grammar: 'html',
    functionNodeTypes: [],
    classNodeTypes: ['element'],
    classNodeLabel: 'markup_element',
    callNodeTypes: [],
    importNodeTypes: ['script_element'],
    resolveName: (node: any) => {
      const st = node.namedChild?.(0);
      if (st?.type !== 'start_tag' && st?.type !== 'self_closing_tag') return firstDescByType(node, 'tag_name');
      return firstDescByType(st, 'tag_name');
    },
  },
  hcl: {
    grammar: 'hcl',
    functionNodeTypes: ['attribute'],
    classNodeTypes: ['block'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => {
      if (node.type === 'block') {
        const labels: string[] = [];
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c.type === 'string_lit') labels.push(c.text.replace(/^["']|["']$/g, ''));
        }
        if (labels.length) return labels[labels.length - 1];
        return node.namedChild(0)?.text || '';
      }
      if (node.type === 'attribute') {
        const id = node.namedChild(0);
        return id?.type === 'identifier' ? id.text : '';
      }
      return '';
    },
  },
  make: {
    grammar: 'make',
    functionNodeTypes: ['rule'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: ['include_directive'],
    resolveName: (node: any) => {
      if (node.type !== 'rule') return '';
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c.type === 'targets') return c.namedChild(0)?.text || '';
      }
      return '';
    },
  },
  dockerfile: {
    grammar: 'dockerfile',
    functionNodeTypes: ['run_instruction', 'copy_instruction', 'add_instruction', 'cmd_instruction', 'entrypoint_instruction'],
    classNodeTypes: ['from_instruction'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => {
      if (node.type === 'from_instruction') {
        for (let i = 0; i < node.namedChildCount; i++) {
          if (node.namedChild(i).type === 'image_alias') return node.namedChild(i).text;
        }
        for (let i = 0; i < node.namedChildCount; i++) {
          if (node.namedChild(i).type === 'image_spec') return node.namedChild(i).namedChild(0)?.text || '';
        }
        return '';
      }
      return node.type.replace(/_instruction$/, '').toUpperCase();
    },
  },
  latex: {
    grammar: 'latex',
    functionNodeTypes: ['new_command_definition', 'old_command_definition', 'let_command_definition'],
    classNodeTypes: ['section', 'subsection', 'chapter', 'part'],
    callNodeTypes: [],
    importNodeTypes: ['package_include', 'class_include'],
    resolveName: (node: any) => {
      const findType = (n: any, t: string): string => {
        if (n.type === t) return n.text;
        for (let i = 0; i < n.namedChildCount; i++) { const r = findType(n.namedChild(i), t); if (r) return r; }
        return '';
      };
      if (/command_definition/.test(node.type)) return findType(node, 'command_name').replace(/^\\/, '');
      if (/section|chapter|part/.test(node.type)) return findType(node, 'word');
      return '';
    },
  },
  julia: {
    grammar: 'julia',
    functionNodeTypes: ['function_definition', 'short_function_definition'],
    classNodeTypes: ['struct_definition'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['using_statement', 'import_statement'],
  },
  clojure: {
    grammar: 'clojure',
    functionNodeTypes: ['list_lit'],
    classNodeTypes: [],
    callNodeTypes: ['list_lit'],
    importNodeTypes: [],
    declFilter: (node: any) => {
      const head = node.namedChildCount > 0 ? node.namedChild(0) : null;
      if (head?.type !== 'sym_lit') return false;
      const t = (head.namedChildCount > 0 ? node.namedChild(0).namedChild(0)?.text : head.text) ?? '';
      return ['defn', 'defn-', 'defmacro', 'defmethod', 'defmulti', 'definline'].includes(t);
    },
    resolveName: (node: any) => {
      if (node.namedChildCount < 2) return '';
      const second = node.namedChild(1);
      return (second.namedChildCount > 0 ? second.namedChild(0)?.text : second?.text) ?? '';
    },
  },
  nim: {
    grammar: 'nim',
    functionNodeTypes: ['proc_declaration', 'func_declaration', 'method_declaration', 'template_declaration', 'macro_declaration', 'iterator_declaration', 'converter_declaration'],
    classNodeTypes: ['type_declaration'],
    callNodeTypes: ['call'],
    importNodeTypes: ['import_statement', 'import_from_statement', 'include_statement'],
  },
  fsharp: {
    grammar: 'fsharp',
    functionNodeTypes: ['function_or_value_defn'],
    classNodeTypes: ['type_definition'],
    callNodeTypes: ['application_expression'],
    importNodeTypes: ['import_decl'],
  },
  crystal: {
    grammar: 'crystal',
    functionNodeTypes: ['method_def'],
    classNodeTypes: ['class_def', 'module_def', 'struct_def', 'enum_def'],
    callNodeTypes: ['call'],
    importNodeTypes: ['require'],
  },
  purescript: {
    grammar: 'purescript',
    functionNodeTypes: ['function'],
    classNodeTypes: ['data', 'newtype', 'class'],
    callNodeTypes: ['exp_apply'],
    importNodeTypes: ['import', 'foreign_import'],
    resolveName: (node: any) => firstDescByType(node, 'variable') || firstDescByType(node, 'type'),
  },
  reason: {
    grammar: 'reason',
    functionNodeTypes: ['let_binding'],
    classNodeTypes: ['type_definition', 'module_definition'],
    callNodeTypes: ['application_expression'],
    importNodeTypes: ['open_statement'],
    resolveName: (node: any) =>
      firstDescByType(node, 'value_name') || firstDescByType(node, 'type_constructor') || firstDescByType(node, 'module_name'),
  },
  pony: {
    grammar: 'pony',
    functionNodeTypes: ['method', 'constructor', 'behavior'],
    classNodeTypes: ['class_definition', 'actor_definition', 'interface_definition', 'trait_definition', 'primitive_definition', 'struct_definition'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['use_statement'],
  },
  tcl: {
    grammar: 'tcl',
    functionNodeTypes: ['procedure'],
    classNodeTypes: [],
    callNodeTypes: ['command'],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'simple_word'),
  },
  wren: {
    grammar: 'wren',
    functionNodeTypes: ['named_method', 'constructor_definition'],
    classNodeTypes: ['class_definition'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_statement'],
  },
  sql: {
    grammar: 'sql',
    functionNodeTypes: ['create_function', 'create_procedure'],
    classNodeTypes: ['create_table', 'create_view', 'create_type'],
    callNodeTypes: ['invocation'],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  graphql: {
    grammar: 'graphql',
    functionNodeTypes: ['operation_definition', 'fragment_definition'],
    classNodeTypes: ['object_type_definition', 'interface_type_definition', 'input_object_type_definition', 'enum_type_definition', 'union_type_definition', 'scalar_type_definition'],
    callNodeTypes: ['field'],
    importNodeTypes: [],
  },
  xml: {
    grammar: 'xml',
    functionNodeTypes: ['element'],
    classNodeTypes: [],
    callNodeTypes: ['EmptyElemTag'],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'Name'),
  },
  vala: {
    grammar: 'vala',
    functionNodeTypes: ['method_declaration', 'creation_method_declaration', 'signal_declaration', 'delegate_declaration', 'local_function_declaration'],
    classNodeTypes: ['class_declaration', 'interface_declaration', 'struct_declaration', 'enum_declaration', 'errordomain_declaration', 'namespace_declaration'],
    callNodeTypes: ['method_call_expression', 'object_creation_expression'],
    importNodeTypes: ['using_directive'],
    resolveName: (node: any) => {
      if (['method_declaration', 'creation_method_declaration', 'signal_declaration', 'delegate_declaration'].includes(node.type)) {
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child?.type === 'symbol') return child.text;
        }
      }
      return firstDescByType(node, 'identifier');
    },
  },
  haxe: {
    grammar: 'haxe',
    functionNodeTypes: ['function_declaration'],
    classNodeTypes: ['class_declaration', 'interface_declaration', 'typedef_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_statement', 'using_statement'],
    nameField: 'name',
  },
  wgsl: {
    grammar: 'wgsl',
    functionNodeTypes: ['function_decl'],
    classNodeTypes: ['struct_decl'],
    callNodeTypes: ['callable'],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'ident'),
  },
  cuda: {
    grammar: 'cuda',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['struct_specifier', 'class_specifier'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['preproc_include'],
  },
  prql: {
    grammar: 'prql',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: [],
    callNodeTypes: ['function_call'],
    importNodeTypes: [],
  },
  hack: {
    grammar: 'hack',
    functionNodeTypes: ['function_declaration', 'method_declaration'],
    classNodeTypes: ['class_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['use_statement', 'namespace_use_declaration'],
  },
  cobol: {
    grammar: 'cobol',
    functionNodeTypes: ['paragraph_header'],
    classNodeTypes: ['program_definition'],
    callNodeTypes: ['call_statement', 'perform_procedure'],
    importNodeTypes: [],
    resolveName: (node: any) =>
      node.type === 'program_definition'
        ? firstDescByType(node, 'program_name')
        : (node.text || '').replace(/\.\s*$/, '').trim(),
  },
  capnp: {
    grammar: 'capnp',
    functionNodeTypes: ['method', 'field', 'const', 'enum_field'],
    classNodeTypes: ['struct', 'interface', 'enum'],
    callNodeTypes: [],
    importNodeTypes: ['using_statement', 'import_path'],
  },
  thrift: {
    grammar: 'thrift',
    functionNodeTypes: ['function_definition', 'field'],
    classNodeTypes: ['struct_definition', 'service_definition', 'enum_definition', 'exception_definition', 'union_definition'],
    callNodeTypes: [],
    importNodeTypes: ['include_declaration'],
  },
  smithy: {
    grammar: 'smithy',
    functionNodeTypes: ['operation_statement'],
    classNodeTypes: ['structure_statement', 'service_statement', 'resource_statement', 'enum_statement', 'union_statement', 'list_statement', 'map_statement'],
    callNodeTypes: [],
    importNodeTypes: ['use_statement'],
  },
  hocon: {
    grammar: 'hocon',
    functionNodeTypes: ['pair'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: ['include'],
    resolveName: (node: any) => (node.namedChild?.(0)?.text || '').trim(),
  },
  dhall: {
    grammar: 'dhall',
    functionNodeTypes: ['let'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => node.nextNamedSibling?.text?.trim() || '',
  },
  yaml: {
    grammar: 'yaml',
    functionNodeTypes: ['block_mapping_pair'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => node.childForFieldName?.('key')?.text || node.namedChild?.(0)?.text || '',
  },
  kdl: {
    grammar: 'kdl',
    functionNodeTypes: [],
    classNodeTypes: ['node'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => node.childForFieldName?.('name')?.text || firstDescByType(node, 'identifier'),
  },
  cue: {
    grammar: 'cue',
    functionNodeTypes: ['field'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: ['package_clause'],
    resolveName: (node: any) => firstDescByType(node, 'identifier') || node.namedChild?.(0)?.text || '',
  },
  nginx: {
    grammar: 'nginx',
    functionNodeTypes: [],
    classNodeTypes: ['attribute', 'location'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => node.type === 'location'
      ? `location ${(node.text || '').replace(/^location\s+/, '').replace(/\s*\{[\s\S]*$/, '').trim()}`
      : firstDescByType(node, 'keyword'),
    declFilter: (node: any) => node.type !== 'location' || /\{/.test(node.text || ''),
  },
  ini: {
    grammar: 'ini',
    functionNodeTypes: ['setting'],
    classNodeTypes: ['section'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => node.type === 'section'
      ? firstDescByType(node, 'text')
      : firstDescByType(node, 'setting_name'),
  },
  sml: {
    grammar: 'sml',
    functionNodeTypes: ['fun_dec'],
    classNodeTypes: ['strbind'],
    callNodeTypes: ['app_exp'],
    importNodeTypes: [],
    resolveName: (node: any) =>
      node.type === 'strbind' ? firstDescByType(node, 'strid') : firstDescByType(node, 'vid'),
  },
  hare: {
    grammar: 'hare',
    functionNodeTypes: ['function_declaration'],
    classNodeTypes: ['type_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['use_statement'],
  },
  gren: {
    grammar: 'gren',
    functionNodeTypes: ['value_declaration'],
    classNodeTypes: ['type_declaration', 'type_alias_declaration'],
    callNodeTypes: ['function_call_expr'],
    importNodeTypes: ['import_clause'],
    resolveName: (node: any) =>
      node.type === 'type_declaration'
        ? firstDescByType(node, 'upper_case_identifier')
        : firstDescByType(node, 'lower_case_identifier'),
  },
  ballerina: {
    grammar: 'ballerina',
    functionNodeTypes: ['function_defn'],
    classNodeTypes: ['class_defn'],
    callNodeTypes: ['function_call_expr'],
    importNodeTypes: ['import_decl'],
  },
  grain: {
    grammar: 'grain',
    functionNodeTypes: ['value_binding'],
    classNodeTypes: ['record_type_declaration', 'enum_declaration'],
    callNodeTypes: ['application_expression'],
    importNodeTypes: ['include_declaration', 'use_statement'],
    resolveName: (node: any): string => {
      if (node.type === 'value_binding') {
        const pat = node.childForFieldName?.('pattern');
        if (pat) return firstDescByType(pat, 'identifier') || pat.text;
        return firstDescByType(node, 'identifier');
      }
      return firstDescByType(node, 'upper_identifier');
    },
    declFilter: (node: any): boolean => {
      if (node.type !== 'value_binding') return true;
      const val = node.childForFieldName?.('value');
      return !!val && val.type === 'lambda_expression';
    },
  },
  awk: {
    grammar: 'awk',
    functionNodeTypes: ['func_def'],
    classNodeTypes: [],
    callNodeTypes: ['func_call'],
    importNodeTypes: [],
    nameField: 'name',
  },
  fish: {
    grammar: 'fish',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: [],
    callNodeTypes: ['command'],
    importNodeTypes: [],
    nameField: 'name',
  },
  jq: {
    grammar: 'jq',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: [],
    callNodeTypes: ['call_expression'],
    importNodeTypes: [],
    nameField: 'name',
  },
  just: {
    grammar: 'just',
    functionNodeTypes: ['recipe'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => {
      const header = node.namedChildCount > 0 ? node.namedChild(0) : null;
      return header?.childForFieldName?.('name')?.text || firstDescByType(node, 'identifier');
    },
  },
  pkl: {
    grammar: 'pkl',
    functionNodeTypes: ['classMethod', 'classProperty'],
    classNodeTypes: ['clazz'],
    callNodeTypes: [],
    importNodeTypes: ['importClause'],
    resolveName: (node: any) =>
      node.type === 'classMethod'
        ? node.namedChild?.(0)?.namedChild?.(0)?.text || ''
        : node.namedChild?.(0)?.text || '',
  },
  typst: {
    grammar: 'typst',
    functionNodeTypes: ['let'],
    classNodeTypes: ['heading'],
    callNodeTypes: ['call'],
    importNodeTypes: ['import'],
    declFilter: (node: any) =>
      (node.namedChildCount > 0 ? node.namedChild(0)?.type : null) === 'call' || node.type !== 'let',
    resolveName: (node: any) => {
      if (node.type === 'heading') return firstDescByType(node, 'text').trim();
      const sig = node.namedChildCount > 0 ? node.namedChild(0) : null;
      return sig?.type === 'call' ? firstDescByType(sig, 'ident') : '';
    },
  },
  janet: {
    grammar: 'janet',
    functionNodeTypes: ['par_tup_lit'],
    classNodeTypes: [],
    callNodeTypes: ['par_tup_lit'],
    importNodeTypes: [],
    declFilter: (node: any) => lispIsDef(node, ['defn', 'defmacro', 'defn-']),
    resolveName: (node: any) => (node.namedChildCount >= 2 ? node.namedChild(1)?.text || '' : ''),
  },
  fennel: {
    grammar: 'fennel',
    functionNodeTypes: ['fn_form', 'lambda_form'],
    classNodeTypes: [],
    callNodeTypes: ['list'],
    importNodeTypes: [],
    importCallNames: ['require'],
    resolveName: (node: any) => (node.namedChildCount >= 2 ? node.namedChild(1)?.text || '' : ''),
  },
  nu: {
    grammar: 'nu',
    functionNodeTypes: ['decl_def'],
    classNodeTypes: [],
    callNodeTypes: ['command'],
    importNodeTypes: ['decl_use'],
    resolveName: (node: any) => firstDescByType(node, 'cmd_identifier'),
  },
  org: {
    grammar: 'org',
    functionNodeTypes: [],
    classNodeTypes: ['headline'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'item').replace(/\s+/g, ' ').trim(),
  },
  vim: {
    grammar: 'vim',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: [],
    callNodeTypes: ['call_expression'],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  apex: {
    grammar: 'apex',
    functionNodeTypes: ['method_declaration', 'constructor_declaration'],
    classNodeTypes: ['class_declaration', 'interface_declaration', 'enum_declaration'],
    callNodeTypes: ['method_invocation'],
    importNodeTypes: ['import_declaration'],
    nameField: 'name',
  },
  bicep: {
    grammar: 'bicep',
    functionNodeTypes: ['module_declaration', 'output_declaration', 'user_defined_function'],
    classNodeTypes: ['resource_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: [],
  },
  puppet: {
    grammar: 'puppet',
    functionNodeTypes: ['function_declaration', 'defined_resource_type'],
    classNodeTypes: ['class_definition'],
    callNodeTypes: ['function_call'],
    importNodeTypes: ['include_statement'],
  },
  rego: {
    grammar: 'rego',
    functionNodeTypes: ['rule'],
    classNodeTypes: [],
    callNodeTypes: ['ref'],
    importNodeTypes: ['import'],
    resolveName: (node: any) => firstDescByType(node.childForFieldName?.('head') || node, 'var'),
  },
  regex: {
    grammar: 'regex',
    functionNodeTypes: ['named_capturing_group'],
    classNodeTypes: ['anonymous_capturing_group', 'non_capturing_group'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (n: any) => firstDescByType(n, 'group_name') || '',
  },
  mermaid: {
    grammar: 'mermaid',
    functionNodeTypes: ['flow_vertex'],
    classNodeTypes: ['diagram_flow', 'diagram_sequence', 'diagram_class', 'diagram_state', 'diagram_er', 'diagram_pie', 'diagram_gantt', 'diagram_mindmap'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (n: any) =>
      n.type.startsWith('diagram_') ? n.type.replace('diagram_', '') : (firstDescByType(n, 'flow_vertex_id') || ''),
  },
  yara: {
    grammar: 'yara',
    functionNodeTypes: ['string_definition'],
    classNodeTypes: ['rule_definition'],
    callNodeTypes: [],
    importNodeTypes: ['import_statement'],
  },
  json5: {
    grammar: 'json5',
    functionNodeTypes: ['member'],
    classNodeTypes: ['object'],
    callNodeTypes: [],
    importNodeTypes: [],
  },
  ron: {
    grammar: 'ron',
    functionNodeTypes: ['struct_entry', 'map_entry'],
    classNodeTypes: ['struct'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (n: any) => firstDescByType(n, 'struct_name'),
    declFilter: (n: any) => n.type !== 'struct' || !!firstDescByType(n, 'struct_name'),
  },
  systemverilog: {
    grammar: 'systemverilog',
    functionNodeTypes: ['function_declaration', 'task_declaration'],
    classNodeTypes: ['module_declaration', 'class_declaration', 'interface_declaration', 'package_declaration', 'program_declaration'],
    callNodeTypes: ['tf_call'],
    importNodeTypes: ['package_import_declaration'],
    resolveName: (node: any) => firstDescByType(node, 'simple_identifier'),
  },
  bibtex: {
    grammar: 'bibtex',
    functionNodeTypes: ['field'],
    classNodeTypes: ['entry'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) =>
      node.type === 'entry' ? firstDescByType(node, 'key_brace') : firstDescByType(node, 'identifier'),
  },
  twig: {
    grammar: 'twig',
    functionNodeTypes: ['block', 'macro'],
    classNodeTypes: [],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['include'],
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  blade: {
    grammar: 'blade',
    functionNodeTypes: [],
    classNodeTypes: ['section'],
    callNodeTypes: [],
    importNodeTypes: ['directive'],
    resolveName: (node: any) => (firstDescByType(node, 'parameter') || '').replace(/^['"]|['"]$/g, ''),
  },
  liquid: {
    grammar: 'liquid',
    functionNodeTypes: ['assignment_statement'],
    classNodeTypes: [],
    callNodeTypes: ['filter'],
    importNodeTypes: ['render_statement', 'include_statement'],
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  yang: {
    grammar: 'yang',
    functionNodeTypes: [],
    classNodeTypes: ['module', 'submodule', 'statement'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => node.type === 'statement'
      ? firstDescByType(node, 'node_identifier')
      : firstDescByType(node, 'identifier'),
    declFilter: (node: any) => node.type !== 'statement' || !!firstDescByType(node, 'node_identifier'),
  },
  p4: {
    grammar: 'p4',
    functionNodeTypes: ['action_declaration', 'table_declaration', 'function_declaration'],
    classNodeTypes: ['control_declaration', 'parser_declaration', 'struct_declaration', 'header_type_declaration'],
    callNodeTypes: ['assignment_or_method_call_statement'],
    importNodeTypes: ['preprocessor_include'],
    resolveName: (node: any) => firstDescByType(node, 'name') || firstDescByType(node, 'identifier'),
  },
  devicetree: {
    grammar: 'devicetree',
    functionNodeTypes: [],
    classNodeTypes: ['node'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  kconfig: {
    grammar: 'kconfig',
    functionNodeTypes: ['config', 'menuconfig'],
    classNodeTypes: ['menu', 'choice'],
    callNodeTypes: [],
    importNodeTypes: ['source'],
    resolveName: (node: any) =>
      (node.type === 'menu' || node.type === 'choice')
        ? firstDescByType(node, 'string_content')
        : firstDescByType(node, 'symbol'),
  },
  mlir: {
    grammar: 'mlir',
    functionNodeTypes: ['operation'],
    classNodeTypes: [],
    callNodeTypes: ['custom_operation'],
    importNodeTypes: [],
    declFilter: (node: any) => mlirOpKeyword(node) === 'func.func',
    resolveName: (node: any) => {
      const m = /@([A-Za-z_][\w.$]*)/.exec(node.text || '');
      return m ? m[1] : '';
    },
    resolveCallee: (node: any) => {
      const op = mlirOpKeyword(node);
      if (op !== 'func.call' && op !== 'call') return '';
      const m = /@([A-Za-z_][\w.$]*)/.exec(node.text || '');
      return m ? m[1] : '';
    },
  },
  ql: {
    grammar: 'ql',
    functionNodeTypes: ['classlessPredicate', 'memberPredicate', 'charpred'],
    classNodeTypes: ['dataclass', 'module'],
    callNodeTypes: ['qualifiedRhs', 'call_or_unqual_agg_expr'],
    importNodeTypes: ['importDirective'],
    resolveName: (n: any) => {
      const want = n.type === 'dataclass' || n.type === 'charpred' ? 'className' : 'predicateName';
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i);
        if (c?.type === want) return c.text;
      }
      return firstDescByType(n, want) || firstDescByType(n, 'predicateName') || firstDescByType(n, 'className');
    },
  },
  tlaplus: {
    grammar: 'tlaplus',
    functionNodeTypes: ['operator_definition'],
    classNodeTypes: ['module'],
    callNodeTypes: ['bound_op'],
    importNodeTypes: ['extends'],
    resolveName: (n: any) => firstDescByType(n, 'identifier'),
  },
  systemrdl: {
    grammar: 'systemrdl',
    functionNodeTypes: ['component_inst'],
    classNodeTypes: ['component_named_def'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (n: any) => firstDescByType(n, 'id'),
  },
  beancount: {
    grammar: 'beancount',
    functionNodeTypes: ['transaction'],
    classNodeTypes: ['open'],
    callNodeTypes: [],
    importNodeTypes: ['include'],
    resolveName: (n: any) =>
      n.type === 'transaction'
        ? (firstDescByType(n, 'payee') || firstDescByType(n, 'narration')).replace(/^"|"$/g, '')
        : firstDescByType(n, 'account'),
  },
  ledger: {
    grammar: 'ledger',
    functionNodeTypes: ['plain_xact'],
    classNodeTypes: ['account_directive'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (n: any) =>
      n.type === 'plain_xact' ? firstDescByType(n, 'payee') : firstDescByType(n, 'account'),
  },
  move: {
    grammar: 'move',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['module_definition', 'struct_definition'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['use_declaration'],
    resolveName: (node: any) => node.type === 'function_definition'
      ? firstDescByType(node, 'function_identifier')
      : node.type === 'struct_definition'
        ? firstDescByType(node, 'struct_identifier')
        : firstDescByType(node, 'module_identifier'),
  },
  cairo: {
    grammar: 'cairo',
    functionNodeTypes: ['function_item'],
    classNodeTypes: ['mod_item', 'struct_item'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['use_declaration'],
    resolveName: (node: any) => node.type === 'struct_item'
      ? firstDescByType(node, 'type_identifier')
      : firstDescByType(node, 'identifier'),
  },
  sway: {
    grammar: 'sway',
    functionNodeTypes: ['function_item'],
    classNodeTypes: ['abi_item', 'struct_item'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['use_declaration'],
    resolveName: (node: any) => node.type === 'function_item'
      ? firstDescByType(node, 'identifier')
      : firstDescByType(node, 'type_identifier'),
  },
  noir: {
    grammar: 'noir',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['struct_definition'],
    callNodeTypes: ['function_call'],
    importNodeTypes: ['import'],
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  clarity: {
    grammar: 'clarity',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['mapping_definition', 'trait_definition'],
    callNodeTypes: ['contract_function_call'],
    importNodeTypes: ['trait_usage', 'trait_implementation'],
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  sourcepawn: {
    grammar: 'sourcepawn',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['enum_struct'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['preproc_include', 'preproc_tryinclude'],
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  robot: {
    grammar: 'robot',
    functionNodeTypes: ['keyword_definition', 'test_case_definition'],
    classNodeTypes: [],
    callNodeTypes: ['keyword_invocation'],
    importNodeTypes: ['setting_statement'],
    nameField: 'name',
  },
  smali: {
    grammar: 'smali',
    functionNodeTypes: ['method_definition'],
    classNodeTypes: ['class_definition'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) =>
      node.type === 'method_definition'
        ? firstDescByType(node, 'method_identifier')
        : firstDescByType(node, 'class_identifier'),
  },
  squirrel: {
    grammar: 'squirrel',
    functionNodeTypes: ['function_declaration'],
    classNodeTypes: ['class_declaration', 'enum_statement'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: [],
  },
  turtle: {
    grammar: 'turtle',
    functionNodeTypes: ['triple'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: ['directive'],
    resolveName: (node: any) => firstDescByType(node, 'subject'),
  },
  func: {
    grammar: 'func',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['global_var_declarations'],
    callNodeTypes: ['function_application'],
    importNodeTypes: ['include_directive'],
    nameField: 'name',
  },
  tact: {
    grammar: 'tact',
    functionNodeTypes: ['global_function', 'storage_function'],
    classNodeTypes: ['contract', 'struct', 'message', 'trait'],
    callNodeTypes: ['static_call_expression', 'method_call_expression'],
    importNodeTypes: ['import'],
    nameField: 'name',
  },
  wing: {
    grammar: 'wing',
    functionNodeTypes: ['method_definition'],
    classNodeTypes: ['class_definition', 'struct_definition', 'interface_definition', 'enum_definition'],
    callNodeTypes: ['call'],
    importNodeTypes: ['import_statement'],
    nameField: 'name',
  },
  cooklang: {
    grammar: 'cooklang',
    functionNodeTypes: ['step'],
    classNodeTypes: ['recipe'],
    callNodeTypes: ['ingredient', 'cookware', 'timer'],
    importNodeTypes: ['metadata'],
    resolveName: (node: any) => {
      if (node.type === 'recipe') {
        const metadata = firstDescByType(node, 'metadata');
        const match = metadata.match(/^>>\s*title:\s*(.+)$/);
        return match?.[1]?.trim() || 'recipe';
      }
      return firstDescByType(node, 'name');
    },
  },
  hurl: {
    grammar: 'hurl',
    functionNodeTypes: ['entry'],
    classNodeTypes: [],
    callNodeTypes: ['capture'],
    importNodeTypes: ['variable_definition'],
    resolveName: (node: any) => {
      if (node.type === 'entry') {
        const url = firstDescByType(node, 'value_string').trim();
        const last = url.split(/[/?#]/).filter(Boolean).pop();
        return last || firstDescByType(node, 'method') || 'entry';
      }
      return firstDescByType(node, 'key_string');
    },
  },
  properties: {
    grammar: 'properties',
    functionNodeTypes: ['property'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    nameField: 'key',
  },
  glimmer: {
    grammar: 'glimmer',
    functionNodeTypes: ['block_statement'],
    classNodeTypes: ['element_node'],
    callNodeTypes: ['helper_invocation'],
    importNodeTypes: [],
    resolveName: (node: any) => node.namedChild?.(0)?.namedChild?.(0)?.text || '',
  },
  todotxt: {
    grammar: 'todotxt',
    functionNodeTypes: ['task', 'done_task'],
    classNodeTypes: ['project'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => node.text.replace(/\s+/g, ' ').trim().slice(0, 80),
  },
  meson: {
    grammar: 'meson',
    functionNodeTypes: [],
    classNodeTypes: [],
    callNodeTypes: ['normal_command'],
    importNodeTypes: [],
    importCallNames: ['subdir'],
  },
  sshconfig: {
    grammar: 'sshconfig',
    functionNodeTypes: ['host_declaration'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    nameField: 'pattern',
  },
  promql: {
    grammar: 'promql',
    functionNodeTypes: [],
    classNodeTypes: [],
    callNodeTypes: ['function_call'],
    importNodeTypes: [],
  },
  sparql: {
    grammar: 'sparql',
    functionNodeTypes: [],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: ['prefix_declaration'],
  },
  supercollider: {
    grammar: 'supercollider',
    functionNodeTypes: ['class_method_name', 'instance_method_name'],
    classNodeTypes: ['class_def'],
    callNodeTypes: ['function_call'],
    importNodeTypes: [],
    resolveName: (node: any) => {
      if (node.type === 'class_def') return firstDescByType(node, 'class');
      if (node.type === 'class_method_name' || node.type === 'instance_method_name') return node.text || '';
      return '';
    },
  },
  templ: {
    grammar: 'templ',
    functionNodeTypes: ['component_declaration', 'function_declaration', 'method_declaration'],
    classNodeTypes: ['type_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_declaration'],
    nameField: 'name',
  },
  gn: {
    grammar: 'gn',
    functionNodeTypes: [],
    classNodeTypes: [],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_statement'],
  },
  po: {
    grammar: 'po',
    functionNodeTypes: [],
    classNodeTypes: ['message'],
    callNodeTypes: [],
    importNodeTypes: [],
    declFilter: (node: any) => {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c.type === 'msgid') return !!firstDescByType(c, 'string_fragment');
      }
      return false;
    },
    resolveName: (node: any) => {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c.type === 'msgid') return firstDescByType(c, 'string_fragment');
      }
      return '';
    },
  },
  rasi: {
    grammar: 'rasi',
    functionNodeTypes: [],
    classNodeTypes: ['rule_set'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'selectors'),
  },
  yuck: {
    grammar: 'yuck',
    functionNodeTypes: [],
    classNodeTypes: ['list'],
    callNodeTypes: [],
    importNodeTypes: [],
    declFilter: (node: any) => {
      const head = node.namedChildCount > 0 ? node.namedChild(0) : null;
      return !!head && head.type === 'symbol' &&
        ['defwidget', 'defwindow', 'defvar', 'defpoll', 'deflisten', 'include'].includes(head.text);
    },
    resolveName: (node: any) => node.namedChild(1)?.text || '',
  },
  tablegen: {
    grammar: 'tablegen',
    functionNodeTypes: [],
    classNodeTypes: ['class', 'def', 'multiclass'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => node.namedChild(0)?.text || '',
  },
  ungrammar: {
    grammar: 'ungrammar',
    functionNodeTypes: [],
    classNodeTypes: ['node'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => node.namedChild(0)?.text || '',
  },
  circom: {
    grammar: 'circom',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['template_definition'],
    callNodeTypes: ['call_expression', 'call'],
    importNodeTypes: ['include_statement'],
    resolveName: (node: any) => firstDescByType(node, 'identifier').trim(),
  },
  opencl: {
    grammar: 'opencl',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['struct_specifier', 'class_specifier'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['preproc_include'],
  },
  cpon: {
    grammar: 'cpon',
    functionNodeTypes: ['pair'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => {
      const s = node.namedChild?.(0);
      return s?.type === 'string' ? s.text.replace(/^"|"$/g, '') : '';
    },
  },
  'gdscript-resource': {
    grammar: 'gdscript-resource',
    functionNodeTypes: ['attribute'],
    classNodeTypes: ['section'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  nasm: {
    grammar: 'nasm',
    functionNodeTypes: ['label'],
    classNodeTypes: [],
    callNodeTypes: ['instruction'],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'ident'),
    resolveCallee: (node: any) => {
      const mnemonic = (firstDescByType(node, 'word') || '').toLowerCase();
      if (!/^(call|jmp|je|jne|jz|jnz|jg|jl|jge|jle|loop)$/.test(mnemonic)) return '';
      return firstDescByType(node, 'ident');
    },
  },
  wat: {
    grammar: 'wat',
    functionNodeTypes: ['module_field_func'],
    classNodeTypes: ['module'],
    callNodeTypes: ['instr_plain'],
    importNodeTypes: ['module_field_import'],
    declFilter: (node: any) => node.type !== 'module' || node.namedChildCount > 0,
    resolveName: (node: any) =>
      node.type === 'module' ? 'module' : firstDescByType(node, 'identifier'),
    resolveCallee: (node: any) => {
      const op = (firstDescByType(node, 'op_index') || '').trim();
      if (op !== 'call' && op !== 'call_indirect') return '';
      return firstDescByType(node, 'identifier');
    },
  },
  fidl: {
    grammar: 'fidl',
    functionNodeTypes: ['protocol_method', 'const_declaration'],
    classNodeTypes: ['layout_declaration', 'protocol_declaration'],
    callNodeTypes: [],
    importNodeTypes: ['using'],
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  http: {
    grammar: 'http',
    functionNodeTypes: ['request'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => {
      const m = firstDescByType(node, 'method');
      const u = firstDescByType(node, 'target_url');
      return [m, u].filter(Boolean).join(' ');
    },
  },
  llvm: {
    grammar: 'llvm',
    functionNodeTypes: ['fn_define', 'declare'],
    classNodeTypes: ['global_type', 'global_global'],
    callNodeTypes: ['instruction_call'],
    importNodeTypes: [],
    resolveName: (node: any) =>
      node.type === 'global_type'
        ? firstDescByType(node, 'local_var')
        : firstDescByType(node, 'global_var'),
    resolveCallee: (node: any) => firstDescByType(node, 'global_var'),
  },
  gitcommit: {
    grammar: 'gitcommit',
    functionNodeTypes: ['subject', 'trailer'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: ['comment'],
    resolveName: (node: any) =>
      node.type === 'trailer'
        ? (firstDescByType(node, 'token') || node.text)
        : node.text.trim(),
  },
  git_rebase: {
    grammar: 'git_rebase',
    functionNodeTypes: ['operation'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => {
      const cmd = firstDescByType(node, 'command');
      const label = firstDescByType(node, 'label');
      return [cmd, label].filter(Boolean).join(' ') || node.text.trim();
    },
  },
  gitattributes: {
    grammar: 'gitattributes',
    functionNodeTypes: [],
    classNodeTypes: ['pattern'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => node.text.trim(),
  },
  diff: {
    grammar: 'diff',
    functionNodeTypes: ['hunk'],
    classNodeTypes: ['block'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => {
      if (node.type === 'block') {
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c.type === 'new_file') return firstDescByType(c, 'filename') || c.text;
        }
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c.type === 'old_file') return firstDescByType(c, 'filename') || c.text;
        }
        return firstDescByType(node, 'filename') || (node.namedChild?.(0)?.text || '').trim();
      }
      return firstDescByType(node, 'location').trim();
    },
  },
  jsonc: {
    grammar: 'jsonc',
    functionNodeTypes: ['pair'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => {
      const k = node.namedChild?.(0);
      if (k?.type !== 'string') return '';
      const sc = k.namedChild?.(0);
      return sc?.type === 'string_content' ? sc.text : '';
    },
  },

  comment: {
    grammar: 'comment',
    functionNodeTypes: ['tag'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'name'),
  },
  query: {
    grammar: 'query',
    functionNodeTypes: ['capture'],
    classNodeTypes: ['named_node'],
    callNodeTypes: ['predicate'],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'identifier'),
  },
  editorconfig: {
    grammar: 'editorconfig',
    functionNodeTypes: [],
    classNodeTypes: ['section'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'glob'),
  },
  requirements: {
    grammar: 'requirements',
    functionNodeTypes: ['requirement'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'package'),
  },
  csv: {
    grammar: 'csv',
    functionNodeTypes: ['field'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => node.text || '',
    declFilter: (node: any) => node.parent?.previousNamedSibling == null,
  },
  gomod: {
    grammar: 'gomod',
    functionNodeTypes: ['require_spec', 'replace_spec'],
    classNodeTypes: ['module_directive'],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'module_path'),
  },
  gosum: {
    grammar: 'gosum',
    functionNodeTypes: ['checksum'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'module_path'),
  },
  gowork: {
    grammar: 'gowork',
    functionNodeTypes: ['use_spec'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'file_path'),
  },
  luau: {
    grammar: 'luau',
    functionNodeTypes: ['fn_stmt', 'local_fn_stmt'],
    classNodeTypes: ['type_stmt'],
    callNodeTypes: ['call_stmt'],
    importNodeTypes: [],
    resolveName: (node: any) => {
      if (node.type === 'type_stmt') return firstDescByType(node, 'name');
      const parts: string[] = [];
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c.type === 'name') parts.push(c.text);
        else if (c.type === 'key') parts.push(firstDescByType(c, 'name'));
        else break;
      }
      return parts.filter(Boolean).join('.');
    },
  },
  gdshader: {
    grammar: 'gdshader',
    functionNodeTypes: ['function_declaration'],
    classNodeTypes: ['struct_declaration'],
    callNodeTypes: ['call_expr'],
    importNodeTypes: [],
    resolveName: (node: any) => firstDescByType(node, 'ident'),
  },
  javascript: {
    grammar: 'javascript',
    functionNodeTypes: ['function_declaration', 'method_definition', 'generator_function_declaration'],
    classNodeTypes: ['class_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_statement'],
    nameField: 'name',
  },
  typescript: {
    grammar: 'typescript',
    functionNodeTypes: ['function_declaration', 'method_definition', 'generator_function_declaration'],
    classNodeTypes: ['class_declaration', 'interface_declaration', 'enum_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_statement'],
    nameField: 'name',
  },
  tsx: {
    grammar: 'tsx',
    functionNodeTypes: ['function_declaration', 'method_definition', 'generator_function_declaration'],
    classNodeTypes: ['class_declaration', 'interface_declaration', 'enum_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_statement'],
    nameField: 'name',
  },
  python: {
    grammar: 'python',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['class_definition'],
    callNodeTypes: ['call'],
    importNodeTypes: ['import_statement', 'import_from_statement'],
    nameField: 'name',
  },
  java: {
    grammar: 'java',
    functionNodeTypes: ['method_declaration', 'constructor_declaration'],
    classNodeTypes: ['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration'],
    callNodeTypes: ['method_invocation'],
    importNodeTypes: ['import_declaration'],
    nameField: 'name',
  },
  go: {
    grammar: 'go',
    functionNodeTypes: ['function_declaration', 'method_declaration'],
    classNodeTypes: ['type_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_declaration'],
    nameField: 'name',
  },
  rust: {
    grammar: 'rust',
    functionNodeTypes: ['function_item'],
    classNodeTypes: ['struct_item', 'trait_item', 'enum_item'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['use_declaration'],
    nameField: 'name',
  },
  ruby: {
    grammar: 'ruby',
    functionNodeTypes: ['method', 'singleton_method'],
    classNodeTypes: ['class', 'module'],
    callNodeTypes: ['call'],
    importNodeTypes: [],
    nameField: 'name',
  },
  php: {
    grammar: 'php',
    functionNodeTypes: ['function_definition', 'method_declaration'],
    classNodeTypes: ['class_declaration', 'interface_declaration', 'trait_declaration'],
    callNodeTypes: ['function_call_expression', 'member_call_expression', 'scoped_call_expression'],
    importNodeTypes: ['namespace_use_declaration'],
    nameField: 'name',
  },
  c: {
    grammar: 'c',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['struct_specifier', 'union_specifier', 'enum_specifier'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['preproc_include'],
    resolveName: (node: any) => {
      const d = node.childForFieldName?.('declarator');
      const find = (x: any): string => {
        if (!x) return '';
        if (x.type === 'identifier') return x.text;
        for (let i = 0; i < x.namedChildCount; i++) {
          const r = find(x.namedChild(i));
          if (r) return r;
        }
        return '';
      };
      return find(d);
    },
  },
  cpp: {
    grammar: 'cpp',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['struct_specifier', 'class_specifier', 'union_specifier', 'enum_specifier'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['preproc_include'],
    resolveName: (node: any) => {
      const d = node.childForFieldName?.('declarator');
      const find = (x: any): string => {
        if (!x) return '';
        if (x.type === 'identifier' || x.type === 'field_identifier') return x.text;
        if (x.type === 'qualified_identifier') return firstDescByType(x, 'identifier');
        for (let i = 0; i < x.namedChildCount; i++) {
          const r = find(x.namedChild(i));
          if (r) return r;
        }
        return '';
      };
      return find(d);
    },
  },
  c_sharp: {
    grammar: 'c_sharp',
    functionNodeTypes: ['method_declaration', 'constructor_declaration', 'local_function_statement'],
    classNodeTypes: ['class_declaration', 'interface_declaration', 'struct_declaration', 'record_declaration', 'enum_declaration'],
    callNodeTypes: ['invocation_expression'],
    importNodeTypes: ['using_directive'],
    nameField: 'name',
  },
  kotlin: {
    grammar: 'kotlin',
    functionNodeTypes: ['function_declaration'],
    classNodeTypes: ['class_declaration', 'object_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_header'],
    resolveName: (node: any) => {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c.type === 'simple_identifier' || c.type === 'type_identifier') return c.text;
      }
      return '';
    },
  },
  swift: {
    grammar: 'swift',
    functionNodeTypes: ['function_declaration'],
    classNodeTypes: ['class_declaration', 'protocol_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_declaration'],
    resolveName: (node: any) => {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c.type === 'simple_identifier' || c.type === 'type_identifier') return c.text;
      }
      return '';
    },
  },
  solidity: {
    grammar: 'solidity',
    functionNodeTypes: ['function_definition', 'modifier_definition', 'constructor_definition'],
    classNodeTypes: ['contract_declaration', 'interface_declaration', 'library_declaration', 'struct_declaration'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_directive'],
    nameField: 'name',
  },
  elixir: {
    grammar: 'elixir',
    functionNodeTypes: ['call'],
    classNodeTypes: [],
    callNodeTypes: [],
    importNodeTypes: [],
    declFilter: (node: any) => {
      const head = firstNamed(node);
      return /^(def|defp|defmodule|defmacro)$/.test(head?.text || '');
    },
    resolveName: (node: any) => {
      const args = node.namedChild?.(1);
      if (!args) return '';
      const inner = args.namedChild?.(0);
      if (!inner) return '';
      if (inner.type === 'alias') return inner.text;
      if (inner.type === 'call') return firstNamed(inner)?.text || '';
      if (/identifier/.test(inner.type)) return inner.text;
      return '';
    },
  },
};

export function specFor(grammar: string): LanguageSpec | undefined {
  return LANGUAGE_SPECS[grammar];
}
