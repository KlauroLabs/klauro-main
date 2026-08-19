import { cachedEstreeParse } from './estree-parse-cache';

export interface StaticMemberCall {
  receiver: string;
  method: string;
  value: string;
  exact: boolean;
  index: number;
  line: number;
}

interface Scope {
  key: string;
  parent?: Scope;
}

interface Binding {
  name: string;
  init: any;
  index: number;
  scope: Scope;
}

interface CandidateCall {
  receiver: string;
  method: string;
  argument: any;
  index: number;
  line: number;
  scope: Scope;
}

interface StringValue {
  value: string;
  exact: boolean;
  staticCharacters: number;
}

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

export function extractStaticMemberCalls(
  content: string,
  receivers: ReadonlySet<string>,
  methods: ReadonlySet<string>
): StaticMemberCall[] {
  let program: any;
  try {
    program = cachedEstreeParse(content, { loc: true, range: true, jsx: true });
  } catch {
    return [];
  }

  const rootScope: Scope = { key: 'program' };
  const bindings = new Map<string, Binding[]>();
  const calls: CandidateCall[] = [];
  const stack: Array<{ node: any; scope: Scope }> = [{ node: program, scope: rootScope }];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const node = current.node;
    if (!node || typeof node !== 'object') continue;

    const scope = FUNCTION_TYPES.has(node.type)
      ? { key: `${node.type}:${node.range?.[0] ?? 0}`, parent: current.scope }
      : current.scope;

    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init) {
      const binding: Binding = {
        name: node.id.name,
        init: node.init,
        index: node.range?.[0] ?? 0,
        scope,
      };
      const existing = bindings.get(binding.name) || [];
      existing.push(binding);
      bindings.set(binding.name, existing);
    }

    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' && !node.callee.computed) {
      const receiver = identifierName(node.callee.object);
      const method = identifierName(node.callee.property)?.toLowerCase();
      if (receiver && method && receivers.has(receiver) && methods.has(method) && node.arguments?.[0]) {
        calls.push({
          receiver,
          method,
          argument: node.arguments[0],
          index: node.range?.[0] ?? 0,
          line: node.loc?.start?.line ?? 1,
          scope,
        });
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent' || key === 'loc' || key === 'range' || key === 'tokens' || key === 'comments') continue;
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index--) {
          if (value[index] && typeof value[index] === 'object') stack.push({ node: value[index], scope });
        }
      } else if (value && typeof value === 'object' && typeof (value as any).type === 'string') {
        stack.push({ node: value, scope });
      }
    }
  }

  for (const values of bindings.values()) values.sort((left, right) => left.index - right.index);

  return calls
    .sort((left, right) => left.index - right.index)
    .map(call => {
      const resolved = resolveString(call.argument, call.index, call.scope, bindings, new Set(), 0);
      if (!resolved || !isUsefulEndpoint(resolved)) return undefined;
      return {
        receiver: call.receiver,
        method: call.method,
        value: normalizeResolvedValue(resolved.value),
        exact: resolved.exact,
        index: call.index,
        line: call.line,
      };
    })
    .filter((call): call is StaticMemberCall => Boolean(call));
}

function resolveString(
  node: any,
  position: number,
  scope: Scope,
  bindings: Map<string, Binding[]>,
  seen: Set<string>,
  depth: number
): StringValue | undefined {
  if (!node || depth > 20) return undefined;

  if (node.type === 'Literal' && typeof node.value === 'string') {
    return { value: node.value, exact: true, staticCharacters: node.value.length };
  }

  if (node.type === 'TemplateLiteral') {
    let value = '';
    let staticCharacters = 0;
    for (let index = 0; index < node.quasis.length; index++) {
      const text = node.quasis[index].value?.cooked ?? node.quasis[index].value?.raw ?? '';
      value += text;
      staticCharacters += text.length;
      if (index < node.expressions.length) value += `:${parameterName(node.expressions[index])}`;
    }
    return { value, exact: node.expressions.length === 0, staticCharacters };
  }

  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = resolveString(node.left, position, scope, bindings, seen, depth + 1) || dynamicValue(node.left);
    const right = resolveString(node.right, position, scope, bindings, seen, depth + 1) || dynamicValue(node.right);
    if (!left || !right) return undefined;
    return {
      value: left.value + right.value,
      exact: left.exact && right.exact,
      staticCharacters: left.staticCharacters + right.staticCharacters,
    };
  }

  if (node.type === 'Identifier') {
    const binding = findBinding(node.name, position, scope, bindings);
    if (!binding) return dynamicValue(node);
    const bindingKey = `${binding.scope.key}:${binding.name}:${binding.index}`;
    if (seen.has(bindingKey)) return undefined;
    const nextSeen = new Set(seen);
    nextSeen.add(bindingKey);
    return resolveString(binding.init, binding.index, binding.scope, bindings, nextSeen, depth + 1);
  }

  if (node.type === 'TSAsExpression' || node.type === 'TSTypeAssertion' || node.type === 'ChainExpression') {
    return resolveString(node.expression, position, scope, bindings, seen, depth + 1);
  }

  return dynamicValue(node);
}

function findBinding(name: string, position: number, scope: Scope, bindings: Map<string, Binding[]>): Binding | undefined {
  const candidates = bindings.get(name) || [];
  let current: Scope | undefined = scope;
  while (current) {
    const match = [...candidates].reverse().find(candidate => candidate.scope.key === current!.key && candidate.index < position);
    if (match) return match;
    current = current.parent;
  }
  return undefined;
}

function dynamicValue(node: any): StringValue {
  return { value: `:${parameterName(node)}`, exact: false, staticCharacters: 0 };
}

function parameterName(node: any): string {
  if (!node) return 'param';
  if (node.type === 'Identifier') return sanitizeParameter(node.name);
  if (node.type === 'MemberExpression') {
    const property = identifierName(node.property);
    if (property) return sanitizeParameter(property);
  }
  if (node.type === 'LogicalExpression') return parameterName(node.left);
  if (node.type === 'ConditionalExpression') return parameterName(node.test);
  return 'param';
}

function identifierName(node: any): string | undefined {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  return undefined;
}

function sanitizeParameter(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_]/g, '');
  return normalized || 'param';
}

function isUsefulEndpoint(value: StringValue): boolean {
  if (value.exact) return value.value.trim().length > 0;
  return value.staticCharacters >= 3 && /[A-Za-z]/.test(value.value) && value.value.includes('/');
}

function normalizeResolvedValue(value: string): string {
  return value
    .replace(/:([A-Za-z0-9_]+)(?=:)/g, ':$1/')
    .replace(/\/+/g, '/')
    .replace(/^(https?):\/(?!\/)/i, '$1://');
}
