export const CONTROL_FLOW_CALLBACK_CALLEES = new Set([
  'then', 'catch', 'finally',
  'setTimeout', 'setInterval', 'setImmediate', 'nextTick', 'queueMicrotask',
  'map', 'filter', 'forEach', 'reduce', 'reduceRight', 'flatMap',
  'find', 'findIndex', 'findLast', 'findLastIndex',
  'some', 'every', 'sort', 'flat', 'at',
  'all', 'allSettled', 'race', 'any',
  'expect', 'waitFor', 'act', 'retry',
  'describe', 'it', 'test', 'suite', 'bench',
  'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'before', 'after',
  'mock', 'hoisted', 'spyOn', 'doMock', 'unmock',
  'mockImplementation', 'mockImplementationOnce',
  'mockReturnValue', 'mockReturnValueOnce',
  'mockResolvedValue', 'mockResolvedValueOnce',
  'mockRejectedValue', 'mockRejectedValueOnce'
]);

export function isRegistrationCallee(calleeName: string | undefined): boolean {
  return Boolean(calleeName) && !CONTROL_FLOW_CALLBACK_CALLEES.has(calleeName as string);
}

export function isHandlerShapedCallback(func: any, calleeName: string | undefined): boolean {
  if (!isRegistrationCallee(calleeName)) return false;
  const body = func.childForFieldName?.('body');
  if (!body || body.type !== 'statement_block') return false;
  return body.endPosition.row > body.startPosition.row;
}

const OPTION_CHAIN_CALLEES = new Set([
  'option', 'requiredOption', 'addHelpText', 'description', 'alias',
  'argument', 'arguments', 'usage', 'summary', 'version', 'example',
  'positional', 'demandOption', 'help', 'epilogue'
]);

export function registrationLabelForArguments(argumentsNode: any): string | undefined {
  let call = argumentsNode?.parent;
  let label: string | undefined;
  for (let depth = 0; depth < 12 && call; depth += 1) {
    if (call.type !== 'call_expression' && call.type !== 'new_expression') break;
    const callee = call.childForFieldName?.('function');
    const calleeName = callee?.type === 'member_expression'
      ? callee.childForFieldName?.('property')?.text
      : callee?.text;
    if (!OPTION_CHAIN_CALLEES.has(String(calleeName))) {
      const found = firstStringArgument(call);
      if (found) label = found;
    }
    call = callee?.type === 'member_expression' ? callee.childForFieldName?.('object') : undefined;
  }
  return label;
}

function firstStringArgument(call: any): string | undefined {
  const args = call.childForFieldName?.('arguments');
  for (const child of args?.namedChildren || []) {
    if (child.type !== 'string' && child.type !== 'template_string') continue;
    const text = String(child.text || '').replace(/^['"`]|['"`]$/g, '');
    if (text.length > 0 && text.length <= 60) return text;
    return undefined;
  }
  return undefined;
}

export function calleeNameForArguments(argumentsNode: any): string | undefined {
  const call = argumentsNode?.parent;
  if (!call || (call.type !== 'call_expression' && call.type !== 'new_expression')) return undefined;
  const callee = call.childForFieldName?.('function');
  if (!callee) return undefined;
  if (callee.type === 'member_expression') return callee.childForFieldName?.('property')?.text || undefined;
  if (callee.type === 'identifier') return callee.text || undefined;
  return undefined;
}

function readableLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().replace(/[^A-Za-z0-9 _./:-]/g, '');
  return cleaned.length > 0 && cleaned.length <= 60 ? cleaned : undefined;
}

export function callbackNodeName(
  callbackOf: string | undefined,
  lineStart: number,
  columnStart: number,
  testSource: boolean,
  registrationLabel?: string
): string {
  if (testSource) return `test_callback_${lineStart}_${columnStart}`;
  const label = readableLabel(registrationLabel);
  if (label) return label;
  const cleaned = (callbackOf || '').replace(/[^A-Za-z0-9_]/g, '');
  const prefix = cleaned.length > 0 && cleaned.length <= 40 ? cleaned : 'callback';
  return `${prefix}_${lineStart}_${columnStart}`;
}
