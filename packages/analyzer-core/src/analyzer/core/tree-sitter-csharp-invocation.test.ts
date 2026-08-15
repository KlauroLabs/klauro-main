import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCSharpInvocationTarget } from './tree-sitter-parser';

test('C# invocation targets retain resolvable references and reject source expressions', () => {
  assert.equal(normalizeCSharpInvocationTarget('_db.taxonomies'), '_db.taxonomies');
  assert.equal(normalizeCSharpInvocationTarget('this.client'), 'this.client');
  assert.equal(normalizeCSharpInvocationTarget('global::System.Console'), 'global::System.Console');
  assert.equal(normalizeCSharpInvocationTarget('(await query.ToListAsync())'), undefined);
  assert.equal(normalizeCSharpInvocationTarget('Factory.Create().Client'), undefined);
  assert.equal(normalizeCSharpInvocationTarget(`(${"x".repeat(300)})`), undefined);
});
