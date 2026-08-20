import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCallableCtags, summarizeOssStudy, type OssRepoResult } from './oss-study';

test('parseCallableCtags keeps callable tags and rejects non-callable tags', () => {
  const output = [
    JSON.stringify({ _type: 'tag', name: 'serve', path: 'app.ts', kind: 'function' }),
    JSON.stringify({ _type: 'tag', name: 'save', path: 'account.ts', kind: 'method' }),
    JSON.stringify({ _type: 'tag', name: 'Account', path: 'account.ts', kind: 'class' }),
    JSON.stringify({ _type: 'tag', name: 'port', path: 'config.ts', kind: 'variable' }),
    JSON.stringify({ _type: 'tag', name: 'heading', path: 'README.md', kind: 'function' }),
    JSON.stringify({ _type: 'tag', name: 'AnonymousFunction123', path: 'test.js', kind: 'function', extras: 'anonymous' }),
    JSON.stringify({ _type: 'tag', name: 'constructor', path: 'test.js', kind: 'method', pattern: '/^Example.prototype.constructor = Object;$/' }),
    JSON.stringify({ _type: 'tag', name: 'constructor', path: 'example.js', kind: 'method', pattern: '/^  constructor(value) {$/' }),
    'not-json',
  ].join('\n');

  assert.deepEqual(parseCallableCtags(output).sort(), ['constructor', 'save', 'serve']);
});

test('OSS study summary distinguishes strict wins, ties, and unmeasured rows on comparable payloads', () => {
  const row = (verdict: OssRepoResult['verdict'], klauroNames: string[], competitorNames: string[]): OssRepoResult => ({
    repo: verdict,
    cloned: true,
    clone_source: 'network',
    klauro: {
      nodes: klauroNames.length,
      functions: klauroNames.length,
      classes: 0,
      tokens: Math.round(Buffer.byteLength(JSON.stringify([...new Set(klauroNames)].sort()), 'utf8') / 4),
      fnNames: klauroNames,
    },
    competitor: null,
    competitor_arms: competitorNames.length ? [{ arm: 'ctags', available: true, names: competitorNames }] : [],
    verdict,
    note: verdict,
  });
  const summary = summarizeOssStudy([
    row('win', ['one', 'two'], ['one']),
    row('tie-ceiling', ['one'], ['one']),
    row('unmeasured', ['one'], []),
  ]);
  assert.equal(summary.compared, 2);
  assert.equal(summary.unmeasured, 1);
  assert.equal(summary.strictWinRate, 0.5);
  assert.equal(summary.nonLossRate, 1);
  assert.equal(summary.avgKlauroToCompetitorTokenRatio, 1);
  assert.equal(summary.tokenRatioComparedPairs, 1);
  assert.equal(summary.tokenRatioExcludedPairs, 1);
  assert.match(summary.tokenRatioNote, /exact same normalized symbol set/);
});

test('OSS token ratio excludes incomplete and broader symbol sets from efficiency evidence', () => {
  const row = (verdict: OssRepoResult['verdict'], klauroNames: string[], competitorNames: string[]): OssRepoResult => ({
    repo: verdict,
    cloned: true,
    clone_source: 'network',
    klauro: {
      nodes: klauroNames.length,
      functions: klauroNames.length,
      classes: 0,
      tokens: Math.round(Buffer.byteLength(JSON.stringify(klauroNames), 'utf8') / 4),
      fnNames: klauroNames,
    },
    competitor: null,
    competitor_arms: [{ arm: 'ctags', available: true, names: competitorNames }],
    verdict,
    note: verdict,
  });

  const summary = summarizeOssStudy([
    row('loss', ['one'], ['one', 'two']),
    row('win', ['one', 'two'], ['one']),
  ]);

  assert.equal(summary.avgKlauroToCompetitorTokenRatio, null);
  assert.equal(summary.tokenRatioComparedPairs, 0);
  assert.equal(summary.tokenRatioExcludedPairs, 2);
});
