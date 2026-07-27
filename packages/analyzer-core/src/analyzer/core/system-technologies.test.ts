/**
 * `system.technologies.languages` REPORTS EVIDENCE, NOT REGISTRATIONS.
 *
 * The live CAS listed `Caddy Reverse Proxy`, `Kubernetes Manifest` and
 * `SOAP/WSDL` at "0 files / 0%" for a repo containing none of them: every
 * registered language-type analyzer contributed a languages entry whether or
 * not it matched anything. An analyzer being registered is not evidence that
 * the language is present.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalyzerOrchestrator } from './orchestrator';

function contributions() {
  return [
    { analyzer_type: 'language', analyzer_name: 'TypeScript/JavaScript Analyzer', nodes_created: 1336, files_created: 1336 },
    { analyzer_type: 'language', analyzer_name: 'Python Analyzer', nodes_created: 10, files_created: 10 },
    // Zero evidence: registered, matched nothing.
    { analyzer_type: 'language', analyzer_name: 'Caddy Reverse Proxy Analyzer', nodes_created: 0, files_created: 0 },
    { analyzer_type: 'language', analyzer_name: 'Kubernetes Manifest Analyzer', nodes_created: 0, files_created: 0 },
    { analyzer_type: 'language', analyzer_name: 'SOAP/WSDL Analyzer', nodes_created: 0, files_created: 0 },
    { analyzer_type: 'framework', analyzer_name: 'Nest Analyzer', confidence: 1 },
  ];
}

function languages() {
  const orchestrator = new AnalyzerOrchestrator() as any;
  // No projectPath -> no source-byte scan, so node counts are the only weight.
  return orchestrator.extractTechnologies(contributions(), []).languages as Array<{ name: string; files: number; percentage: number }>;
}

test('languages with zero files and zero nodes are not reported', () => {
  const names = languages().map(language => language.name);
  assert.deepEqual(names, ['TypeScript/JavaScript', 'Python']);
  for (const dropped of ['Caddy Reverse Proxy', 'Kubernetes Manifest', 'SOAP/WSDL']) {
    assert.ok(!names.includes(dropped), `${dropped} has no evidence and must not be reported`);
  }
});

test('every reported language carries real evidence', () => {
  for (const language of languages()) {
    assert.ok(language.files > 0, `${language.name} reported with 0 files`);
    assert.ok(language.percentage > 0, `${language.name} reported at 0%`);
  }
});
