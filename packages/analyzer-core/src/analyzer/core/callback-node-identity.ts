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

export function calleeNameForArguments(argumentsNode: any): string | undefined {
  const call = argumentsNode?.parent;
  if (!call || (call.type !== 'call_expression' && call.type !== 'new_expression')) return undefined;
  const callee = call.childForFieldName?.('function');
  if (!callee) return undefined;
  if (callee.type === 'member_expression') return callee.childForFieldName?.('property')?.text || undefined;
  if (callee.type === 'identifier') return callee.text || undefined;
  return undefined;
}

export function callbackNodeName(
  callbackOf: string | undefined,
  lineStart: number,
  columnStart: number,
  testSource: boolean
): string {
  if (testSource) return `test_callback_${lineStart}_${columnStart}`;
  const cleaned = (callbackOf || '').replace(/[^A-Za-z0-9_]/g, '');
  const prefix = cleaned.length > 0 && cleaned.length <= 40 ? cleaned : 'callback';
  return `${prefix}_${lineStart}_${columnStart}`;
}
