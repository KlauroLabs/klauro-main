import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TreeSitterTSExtractor } from './tree-sitter-ts-extractor';
import { callbackNodeName, isRegistrationCallee } from './callback-node-identity';

// Inline handlers become nodes, and their names reach the customer: a flow is
// named after the function behind it. Naming them by position produced flows
// called "Action 69 12", which is the same defect class as any other machine
// token leaking into a label. The name now comes from the registration the
// handler is attached to, so the flow is called "call" or "/act".
//
// The subtlety is the builder chain. A command is registered as
// .command("call").description(...).requiredOption("-m, --message <text>")
// .option("--mode <mode>").action(handler), so the nearest string literal to
// the handler is an option flag, not the command name. Option-shaped calls are
// skipped and the walk continues to the base of the chain.

function labelsIn(source: string): Array<{ line: number; callbackOf?: string; label?: string }> {
  const extraction = new TreeSitterTSExtractor().extractFromSource(source, 'sample.ts');
  return extraction.functions
    .filter(fn => fn.isAnonymousCallback)
    .map(fn => ({ line: fn.lineStart, callbackOf: fn.callbackOf, label: fn.registrationLabel }));
}

test('a command handler is named after the command, not the last option flag', () => {
  const found = labelsIn(`
function register(root) {
  root
    .command("call")
    .description("Initiate an outbound call")
    .requiredOption("-m, --message <text>", "Message to speak")
    .option("--mode <mode>", "Call mode")
    .action(async (options) => {
      const result = await start(options);
      return result;
    });
}
`);
  assert.equal(found.length, 1);
  assert.equal(found[0].callbackOf, 'action');
  assert.equal(found[0].label, 'call');
});

test('a route handler is named after its path', () => {
  const found = labelsIn(`
function routes(app) {
  app.post("/hooks/file-chooser", async (c) => {
    const body = await c.req.json();
    return c.json(body);
  });
}
`);
  assert.equal(found[0].label, '/hooks/file-chooser');
  assert.equal(callbackNodeName(found[0].callbackOf, 10, 4, false, found[0].label), '/hooks/file-chooser');
});

test('a handler with no named registration falls back to callee and position', () => {
  const found = labelsIn(`
function wire(bus) {
  bus.onMessage(async (message) => {
    await handle(message);
    return true;
  });
}
`);
  assert.equal(found[0].label, undefined);
  assert.equal(callbackNodeName(found[0].callbackOf, 3, 20, false, undefined), 'onMessage_3_20');
});

test('test files keep their existing positional naming', () => {
  assert.equal(callbackNodeName('action', 45, 34, true, 'call'), 'test_callback_45_34');
});

test('control flow and test scaffolding are not registrations', () => {
  for (const callee of ['then', 'catch', 'map', 'forEach', 'setTimeout', 'describe', 'it', 'mock']) {
    assert.equal(isRegistrationCallee(callee), false, `${callee} is not a registration`);
  }
  for (const callee of ['action', 'post', 'on', 'use', 'subscribe']) {
    assert.equal(isRegistrationCallee(callee), true, `${callee} is a registration`);
  }
  assert.equal(isRegistrationCallee(undefined), false);
});

test('a label that is not readable is rejected rather than shipped', () => {
  const noisy = 'x'.repeat(80);
  assert.equal(callbackNodeName('action', 5, 2, false, noisy), 'action_5_2');
  assert.equal(callbackNodeName('action', 5, 2, false, '   '), 'action_5_2');
});

test('single-expression callbacks inside a function are not captured at all', () => {
  // .map(x => x.id) is not a unit of behaviour. Without this the same rule
  // captured 13,764 callbacks in one directory and the graph became too large
  // to serialise.
  const found = labelsIn(`
function pick(rows) {
  return rows.map(row => row.id).filter(id => id != null);
}
`);
  assert.equal(found.length, 0);
});
