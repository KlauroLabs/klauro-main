










import { parseWasm, hasWasmGrammar } from './wasm-tree-sitter';
import { parseNativeRoot, hasNativeGrammar } from './native-parse';
import { specFor, type LanguageSpec } from './language-spec';

export interface ExtractedFunction { name: string; line: number }
export interface ExtractedClass { name: string; line: number }
export interface ExtractedCall { callee: string; line: number }
export interface ExtractedImport { module: string; line: number }

export interface StructuralExtract {
  grammar: string;
  functions: ExtractedFunction[];
  classes: ExtractedClass[];
  calls: ExtractedCall[];
  imports: ExtractedImport[];
}

const NAME_LEAF = /(^|_)(identifier|atom|name|var|constant|word)$|identifier$|dot_index|qualified/i;


const SKIP_DESCEND = /body|block|argument|parameter/i;



function findNameLeaf(node: any, depth = 0): string {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (NAME_LEAF.test(c.type)) return c.text;
  }
  if (depth < 3) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (!SKIP_DESCEND.test(c.type)) {
        const r = findNameLeaf(c, depth + 1);
        if (r) return r;
      }
    }
  }
  return '';
}



function declName(node: any, spec: LanguageSpec): string {
  if (spec.resolveName) {
    const n = spec.resolveName(node);
    if (n) return n;
  }
  if (spec.nameField) {
    const f = node.childForFieldName?.(spec.nameField);
    if (f && f.text) return f.text;
  }
  const leaf = findNameLeaf(node);
  if (leaf) return leaf;
  return node.namedChild?.(0)?.text || '';
}


function calleeName(node: any): string {
  const first = node.namedChild?.(0);
  return first?.text || '';
}





export async function extractStructure(grammar: string, source: string): Promise<StructuralExtract | null> {
  const spec = specFor(grammar);
  if (!spec) return null;



  let root: any = null;
  let wasmTree: any = null;
  if (hasWasmGrammar(spec.grammar)) {
    try {
      wasmTree = await parseWasm(spec.grammar, source);
      root = wasmTree.rootNode;
    } catch {
      root = null;
    }
  }
  if (!root && hasNativeGrammar(spec.grammar)) {
    root = parseNativeRoot(spec.grammar, source);
  }
  if (!root) return null;

  const fnTypes = new Set(spec.functionNodeTypes);
  const classTypes = new Set(spec.classNodeTypes);
  const callTypes = new Set(spec.callNodeTypes);
  const importTypes = new Set(spec.importNodeTypes);
  const importCallNames = new Set(spec.importCallNames || []);

  const out: StructuralExtract = { grammar: spec.grammar, functions: [], classes: [], calls: [], imports: [] };

  const visit = (node: any) => {
    const t = node.type;
    const line = (node.startPosition?.row ?? 0) + 1;
    const declOk = !spec.declFilter || spec.declFilter(node);
    if (fnTypes.has(t) && declOk) {
      const name = declName(node, spec);
      if (name) out.functions.push({ name, line });
    } else if (classTypes.has(t) && declOk) {
      const name = declName(node, spec);
      if (name) out.classes.push({ name, line });
    } else if (importTypes.has(t)) {
      out.imports.push({ module: node.text.slice(0, 120), line });
    } else if (callTypes.has(t)) {




      const callee = spec.resolveCallee ? spec.resolveCallee(node) : calleeName(node);
      if (importCallNames.has(callee.replace(/\s*\(.*$/, ''))) {
        out.imports.push({ module: node.text.slice(0, 120), line });
      } else if (callee) {
        out.calls.push({ callee, line });
      }
    }
    for (let i = 0; i < node.childCount; i++) visit(node.child(i));
  };
  try {
    visit(root);
    return out;
  } finally {
    wasmTree?.delete?.();
  }
}
