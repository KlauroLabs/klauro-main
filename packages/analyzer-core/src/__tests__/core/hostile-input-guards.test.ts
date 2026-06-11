jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { TreeSitterTSExtractor } from '../../analyzer/core/tree-sitter-ts-extractor';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';
import { CASAnalysisError } from '../../types/cas.types';

describe('hostile input guards', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-hostile-'));
  });

  afterEach(async () => {
    const restore = async (target: string): Promise<void> => {
      try {
        await fs.chmod(target, 0o700);
        const entries = await fs.readdir(target, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.isSymbolicLink()) {
            await restore(path.join(target, entry.name));
          }
        }
      } catch {
        return;
      }
    };
    await restore(tempDir);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('TreeSitterTSExtractor syntax error detection', () => {
    it('flags broken TypeScript source as having syntax errors', () => {
      const extractor = new TreeSitterTSExtractor();
      const extraction = extractor.extractFromSource('export function ((( {{{ const class =>\n}}}}', 'broken.ts');
      expect(extraction.hasSyntaxErrors).toBe(true);
    });

    it('does not flag valid TypeScript source', () => {
      const extractor = new TreeSitterTSExtractor();
      const extraction = extractor.extractFromSource('export function ok(): number { return 1; }\n', 'ok.ts');
      expect(extraction.hasSyntaxErrors).toBe(false);
    });
  });

  describe('TypeScriptJavaScriptAnalyzer file guards', () => {
    it('skips oversized source files with a truncation warning instead of parsing them', async () => {
      const analyzer = new TypeScriptJavaScriptAnalyzer() as any;
      analyzer.analysisWarnings = [];
      analyzer.suppressedWarningCount = 0;
      const bigFile = 'big.ts';
      const line = 'export const filler = 1;\n';
      const stream = fs.createWriteStream(path.join(tempDir, bigFile));
      const chunk = line.repeat(10_000);
      let written = 0;
      const target = 6 * 1024 * 1024;
      await new Promise<void>((resolve, reject) => {
        stream.on('error', reject);
        const writeMore = () => {
          while (written < target) {
            written += Buffer.byteLength(chunk);
            if (!stream.write(chunk)) {
              stream.once('drain', writeMore);
              return;
            }
          }
          stream.end(() => resolve());
        };
        writeMore();
      });

      const preloaded = await analyzer.preloadFilesWithTreeSitter([bigFile], tempDir);
      expect(preloaded).toHaveLength(0);
      const warnings: string[] = analyzer.collectAnalysisWarnings();
      expect(warnings.some(warning => warning.includes(bigFile) && warning.includes('skipped'))).toBe(true);
    });

    it('records a warning for files with syntax errors while still extracting what it can', async () => {
      const analyzer = new TypeScriptJavaScriptAnalyzer() as any;
      analyzer.analysisWarnings = [];
      analyzer.suppressedWarningCount = 0;
      await fs.writeFile(path.join(tempDir, 'broken.ts'), 'export function ((( {{{ const class =>\n}}}}');
      await fs.writeFile(path.join(tempDir, 'ok.ts'), 'export const fine = true;\n');

      const preloaded = await analyzer.preloadFilesWithTreeSitter(['broken.ts', 'ok.ts'], tempDir);
      expect(preloaded.length).toBe(2);
      const warnings: string[] = analyzer.collectAnalysisWarnings();
      expect(warnings.some(warning => warning.includes('broken.ts') && warning.includes('syntax errors'))).toBe(true);
      expect(warnings.some(warning => warning.includes('ok.ts'))).toBe(false);
    });

    it('tolerates an unparseable package.json and reports it as a warning', async () => {
      const analyzer = new TypeScriptJavaScriptAnalyzer() as any;
      await fs.writeFile(path.join(tempDir, 'package.json'), '{ "name": "broken", "dependencies": { "left-pad": ');
      await fs.writeFile(path.join(tempDir, 'index.ts'), 'export const ok = true;\n');

      const contribution = await analyzer.analyze({ projectPath: tempDir });
      const warnings: string[] = contribution.analyzer_metadata.warnings || [];
      expect(warnings.some(warning => warning.includes('package.json'))).toBe(true);
      expect(contribution.nodes.length).toBeGreaterThan(0);
    });

    it('caps the number of reported file warnings', () => {
      const analyzer = new TypeScriptJavaScriptAnalyzer() as any;
      analyzer.analysisWarnings = [];
      analyzer.suppressedWarningCount = 0;
      for (let i = 0; i < 40; i++) {
        analyzer.addAnalysisWarning(`file-${i}.ts could not be parsed`);
      }
      const warnings: string[] = analyzer.collectAnalysisWarnings();
      expect(warnings).toHaveLength(26);
      expect(warnings[25]).toContain('15 additional file warnings suppressed');
    });
  });

  describe('orchestrator readability warnings', () => {
    it('reports an unparseable root package.json as a manifest warning', async () => {
      const orchestrator = new AnalyzerOrchestrator() as any;
      await fs.writeFile(path.join(tempDir, 'package.json'), '{ invalid json');
      const analysisErrors: CASAnalysisError[] = [];
      orchestrator.collectProjectReadabilityWarnings(tempDir, analysisErrors);
      const manifestWarning = analysisErrors.find(entry => entry.code === 'MANIFEST_PARSE_ERROR');
      expect(manifestWarning).toBeDefined();
      expect(manifestWarning?.severity).toBe('warning');
    });

    it('reports permission-denied subdirectories without throwing', async () => {
      const secret = path.join(tempDir, 'secret');
      await fs.mkdirp(secret);
      await fs.writeFile(path.join(secret, 'hidden.ts'), 'export const hidden = true;\n');
      await fs.chmod(secret, 0o000);

      const orchestrator = new AnalyzerOrchestrator() as any;
      const analysisErrors: CASAnalysisError[] = [];
      orchestrator.collectProjectReadabilityWarnings(tempDir, analysisErrors);
      const denied = analysisErrors.find(entry => entry.code === 'PERMISSION_DENIED');
      expect(denied).toBeDefined();
      expect(denied?.message).toContain('secret');
    });

    it('does not follow symlinked directories while scanning', async () => {
      await fs.mkdirp(path.join(tempDir, 'a'));
      await fs.mkdirp(path.join(tempDir, 'b'));
      await fs.symlink(path.join(tempDir, 'b'), path.join(tempDir, 'a', 'to-b'));
      await fs.symlink(path.join(tempDir, 'a'), path.join(tempDir, 'b', 'to-a'));
      await fs.symlink('/', path.join(tempDir, 'escape'));

      const orchestrator = new AnalyzerOrchestrator() as any;
      const analysisErrors: CASAnalysisError[] = [];
      orchestrator.collectProjectReadabilityWarnings(tempDir, analysisErrors);
      expect(analysisErrors.filter(entry => entry.code === 'PERMISSION_DENIED')).toHaveLength(0);
    });

    it('buildRuntime tolerates an invalid package.json', async () => {
      await fs.writeFile(path.join(tempDir, 'package.json'), '{ broken');
      const orchestrator = new AnalyzerOrchestrator() as any;
      const runtime = orchestrator.buildRuntime(tempDir, [], [], [], {}, []);
      expect(runtime).toBeDefined();
    });
  });
});
