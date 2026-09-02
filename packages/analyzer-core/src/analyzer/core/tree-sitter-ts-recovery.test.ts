import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TreeSitterTSExtractor } from './tree-sitter-ts-extractor';

const extractor = new TreeSitterTSExtractor();

test('recovers raw logical operators used as JSX text without hiding malformed JSX', () => {
  const valid = extractor.extractFromSource(
    'export function Help() { return <p>Use <span>&&</span> and <span>||</span></p>; }',
    'Help.tsx',
  );
  assert.equal(valid.hasSyntaxErrors, false);
  assert.ok(valid.functions.some(fn => fn.name === 'Help'));

  const invalid = extractor.extractFromSource(
    'export function Broken() { return <p><span>&&</p>; }',
    'Broken.tsx',
  );
  assert.equal(invalid.hasSyntaxErrors, true);
  assert.ok(invalid.syntaxErrorLocations?.length);
});

test('recovers nested typeof-import generic call arguments while retaining the runtime call', () => {
  const extraction = extractor.extractFromSource(
    'export async function load(importOriginal: Function) { return importOriginal<typeof import("pkg")>(); }',
    'generic-call.tsx',
  );
  assert.equal(extraction.hasSyntaxErrors, false);
  const load = extraction.functions.find(fn => fn.name === 'load');
  assert.ok(load?.calls.some(call => call.target === 'importOriginal'));
});

test('recovers HTML-like text inside a simple interpolated template and preserves original call evidence', () => {
  const extraction = extractor.extractFromSource(
    'export function check(expect: Function, html: string, prefix: string) { expect(html).toContain(`${prefix}<span class="tag">value</span>`); }',
    'template-markup.tsx',
  );
  assert.equal(extraction.hasSyntaxErrors, false);
  const call = extraction.functions
    .find(fn => fn.name === 'check')
    ?.calls.find(candidate => candidate.callExpression.includes('toContain'));
  assert.ok(call?.callExpression.includes('<span class="tag">'));
});

test('does not recover genuinely malformed generic calls', () => {

  const malformedGeneric = extractor.extractFromSource(
    'export function broken(importOriginal: Function) { return importOriginal<typeof import("pkg")>();',
    'malformed-generic.tsx',
  );
  assert.equal(malformedGeneric.hasSyntaxErrors, true);
});
