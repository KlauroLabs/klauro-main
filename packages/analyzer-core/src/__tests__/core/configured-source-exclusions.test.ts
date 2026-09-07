jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';
import { glob } from 'glob';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

test.each(['.klauroignore', '.klaurorc'])('keeps source filenames distinct from directory exclusions in %s', async configName => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-configured-directories-'));
  const files = [
    'src/telemetry-credential-http.ts',
    'src/telemetry-project-credentials.test.ts',
    'src/telemetry-project-credentials.ts',
    'src/secret-manager.ts',
    'src/credential-store/token.ts',
    'src/credential-store/nested/token.ts',
    'src/secrets/token.ts',
    'src/secrets/nested/token.ts',
    'src/custom-excluded.ts',
    'src/normal.ts',
  ];
  const patterns = ['**/*credential*/**', '**/*secret*/**', '**/custom-excluded.ts'];
  try {
    for (const file of files) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'export const value = 1;\n');
    }
    fs.writeFileSync(path.join(root, configName), configName === '.klauroignore'
      ? patterns.join('\n')
      : JSON.stringify({ source: { exclude: patterns } }));
    const orchestrator = new AnalyzerOrchestrator() as any;
    const filters = await orchestrator.getAnalysisContextFilters(root);
    const analyzer = new TypeScriptJavaScriptAnalyzer() as any;
    const selected = await glob(['**/*.{js,jsx,ts,tsx,mjs,cjs}'], {
      cwd: root,
      ignore: analyzer.getLanguageIgnorePatterns({ projectPath: root, filters }),
      nodir: true,
    });
    expect(selected.sort()).toEqual([
      'src/normal.ts',
      'src/secret-manager.ts',
      'src/telemetry-credential-http.ts',
      'src/telemetry-project-credentials.test.ts',
      'src/telemetry-project-credentials.ts',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
