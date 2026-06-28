/**
 * Generic tree-sitter structural extractor — the breadth engine's walker.
 *
 * Given any grammar that has a `LanguageSpec`, walk the AST once and pull out the
 * structural facts every code-intelligence tool needs: functions, classes,
 * calls, imports. This is the same move that lets codebase-memory-mcp cover 158
 * languages from one walker + a per-language node-type table — replicated here on
 * our `tree-sitter-wasms` grammars. A language is covered the moment it has a
 * spec; no bespoke analyzer required.
 */

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
// Skip executable/payload subtrees when hunting for a declaration's name, but
// NOT header nodes like `subroutine_statement`/`function_statement` that carry it.
const SKIP_DESCEND = /body|block|argument|parameter/i;

/** First identifier-like leaf within a declaration, descending past wrappers
 *  (e.g. erlang `fun_decl → function_clause → atom`) but NOT into bodies/args. */
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

/** The identifier text for a declaration node. Prefer the grammar's name field,
 *  else the first identifier-like descendant. */
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

/** The callee text of a call node = its first (function-position) child. */
function calleeName(node: any): string {
  const first = node.namedChild?.(0);
  return first?.text || '';
}

/**
 * Extract structural facts from source using the grammar's spec. Returns null if
 * the grammar isn't available or has no spec (so callers can fall back).
 */
export async function extractStructure(grammar: string, source: string): Promise<StructuralExtract | null> {
  const spec = specFor(grammar);
  if (!spec) return null;

  // Parse stage: wasm where available (fast path), else the native Rust binary
  // (the breadth long tail). Both yield a node with the same walk surface.
  let root: any = null;
  if (hasWasmGrammar(spec.grammar)) {
    try {
      root = (await parseWasm(spec.grammar, source)).rootNode;
    } catch {
      root = null; // wasm grammar broken — fall through to native if available
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
      // Callee resolution: use the spec's resolveCallee hook when present (the
      // assembly/IR tier, where the callee is a later operand, not the first
      // child); otherwise fall back to the generic first-child behavior. Purely
      // additive — specs without resolveCallee are unaffected.
      const callee = spec.resolveCallee ? spec.resolveCallee(node) : calleeName(node);
      if (importCallNames.has(callee.replace(/\s*\(.*$/, ''))) {
        out.imports.push({ module: node.text.slice(0, 120), line });
      } else if (callee) {
        out.calls.push({ callee, line });
      }
    }
    for (let i = 0; i < node.childCount; i++) visit(node.child(i));
  };
  visit(root);

  return out;
}
