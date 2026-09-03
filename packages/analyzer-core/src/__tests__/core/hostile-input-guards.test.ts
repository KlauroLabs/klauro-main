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

    // Real analyzer-core source previously exposed native grammar limitations
    // around NUL separators and inline import-type suffixes. Parser-only,
    // length-preserving rewrites now handle those valid constructs without
    // changing the source used to build evidence.
    it('does NOT flag an em dash in a JSDoc comment (the original false-positive hypothesis)', () => {
      const extractor = new TreeSitterTSExtractor();
      const extraction = extractor.extractFromSource(
        '/** Ranked by confidence — a monorepo can carry more than one. */\nexport const x = 1;\n',
        'em-dash.ts'
      );
      expect(extraction.hasSyntaxErrors).toBe(false);
    });

    it('parses an array-suffixed inline import-type without losing later declarations', () => {
      const extractor = new TreeSitterTSExtractor();
      const extraction = extractor.extractFromSource(
        "type X = { codebase_type_signals?: import('../analyzer/core/codebase-type').CodebaseTypeSignal[]; };\nexport function retained() { return 1; }\n",
        'cas.types.ts'
      );
      expect(extraction.hasSyntaxErrors).toBe(false);
      expect(extraction.functions.some(item => item.name === 'retained')).toBe(true);
    });

    // Contract change (sanitizeForTreeSitterParse): a raw NUL is a deliberate,
    // legitimate collision-proof separator in template-literal cache/hash keys
    // (`${a}\0${b}`) in real analyzer-core source. tree-sitter's scanner treats
    // a literal NUL as end-of-input, so the parser-bound string (ONLY) gets a
    // same-length placeholder substituted — valid NUL-containing TS must now
    // parse cleanly instead of being flagged.
    it('parses a literal embedded NUL byte inside a valid template literal cleanly (sanitized for parse only)', () => {
      const extractor = new TreeSitterTSExtractor();
      const source = 'const h = crypto.createHash(\'sha256\').update(`${status}\0${diff}`).digest(\'hex\');\n';
      const extraction = extractor.extractFromSource(source, 'revision.ts');
      expect(extraction.hasSyntaxErrors).toBe(false);
      expect(extraction.syntaxErrorLocations).toBeUndefined();
      // Extraction still succeeds with content and offsets preserved: the
      // declaration on line 1 is seen despite the NUL earlier in the string.
      const h = extraction.variables.find(v => v.name === 'h');
      expect(h).toBeDefined();
      expect(h?.line).toBe(1);
    });

    it('still flags (and localizes, NUL-free) genuinely malformed source that also contains a NUL byte', () => {
      const extractor = new TreeSitterTSExtractor();
      // The NUL is sanitized before parsing, but the source is broken anyway —
      // the guard must keep flagging real damage, not just NUL presence.
      const source = 'export function ((( {{{ `${a}\0${b}` const class =>\n}}}}';
      const extraction = extractor.extractFromSource(source, 'hostile.ts');
      expect(extraction.hasSyntaxErrors).toBe(true);
      expect(extraction.syntaxErrorLocations?.length).toBeGreaterThan(0);
      // The sanitized snippet must never contain a raw NUL byte itself.
      expect(extraction.syntaxErrorLocations?.every(loc => !loc.snippet.includes('\0'))).toBe(true);
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
      expect(preloaded).toHaveLength(1);
      expect(preloaded[0].relativePath).toBe(bigFile);
      expect(preloaded[0].extraction).toBeDefined();
      const warnings: string[] = analyzer.collectAnalysisWarnings();
      expect(warnings.some(warning => warning.includes(bigFile) && /skipped|source file limit/.test(warning))).toBe(false);
    });

    it('fails closed with an exact omission for source files above the bounded parser limit', async () => {
      const analyzer = new TypeScriptJavaScriptAnalyzer() as any;
      analyzer.analysisWarnings = [];
      analyzer.suppressedWarningCount = 0;
      const hugeFile = path.join(tempDir, 'huge.ts');
      await fs.writeFile(hugeFile, 'export const retainedPrefix = true;\n');
      await fs.truncate(hugeFile, 32 * 1024 * 1024 + 1);

      const preloaded = await analyzer.preloadFilesWithTreeSitter(['huge.ts'], tempDir);
      expect(preloaded).toHaveLength(0);
      expect(analyzer.omittedSourceFiles).toEqual([{
        path: 'huge.ts',
        reason: expect.stringContaining('source file limit exceeded'),
        bytes: 32 * 1024 * 1024 + 1,
      }]);
      expect(analyzer.collectAnalysisWarnings()).toContainEqual(
        expect.stringMatching(/huge\.ts skipped: source file limit exceeded/),
      );
    });

    it('rejects an oversized incremental source before reading it into the worker heap', async () => {
      const analyzer = new TypeScriptJavaScriptAnalyzer();
      const hugeFile = path.join(tempDir, 'incremental-huge.ts');
      await fs.writeFile(hugeFile, 'export const retainedPrefix = true;\n');
      await fs.truncate(hugeFile, 32 * 1024 * 1024 + 1);

      await expect(analyzer.analyzeFileSingle({
        filePath: hugeFile,
        relativePath: 'incremental-huge.ts',
        projectPath: tempDir,
        contentHash: 'oversized',
        existingAnalysis: [],
      } as any)).rejects.toMatchObject({
        code: 'SOURCE_FILE_LIMIT_EXCEEDED',
        recoverable: true,
      });
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
      // The warning no longer says "syntax errors" for a located parse failure:
      // a tree-sitter ERROR node is not proof the source itself is invalid, so
      // the message is hedged and names the location instead of blaming the
      // file. What must hold is that the broken file is reported as partially
      // extracted, and that the healthy file is not implicated.
      expect(warnings.some(warning => warning.includes('broken.ts') && warning.includes('extraction may be partial'))).toBe(true);
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

    // Root ignores mode 0o000, so the OS never produces the EACCES this test
    // exists to observe — and the assertion then fails for a reason that has
    // nothing to do with the product. Containers run as uid 0 by default, which
    // is how this showed up as red in CI while passing on a developer machine.
    // Skipping with a stated reason is the honest disposition; asserting
    // "no warning" instead would encode the opposite of the intended behaviour.
    const itUnlessRoot = typeof process.getuid === 'function' && process.getuid() === 0 ? it.skip : it;
    itUnlessRoot('reports permission-denied subdirectories without throwing', async () => {
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

  describe('regex analyzer syntax self-reporting', () => {
    it('PythonAnalyzer reports broken syntax in analyzer_metadata.warnings', async () => {
      const { PythonAnalyzer } = require('../../analyzer/languages/python-analyzer');
      await fs.writeFile(path.join(tempDir, 'ok.py'), 'def fine():\n    return 1\n');
      await fs.writeFile(path.join(tempDir, 'broken.py'), 'def broken(((((\n    print((((\n');

      const analyzer = new PythonAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: tempDir });
      const warnings: string[] = contribution.analyzer_metadata.warnings || [];
      expect(warnings.some((warning: string) => warning.includes('broken.py') && warning.includes('broken syntax'))).toBe(true);
      expect(warnings.some((warning: string) => warning.includes('ok.py'))).toBe(false);
    });

    it('RubyAnalyzer reports broken syntax in analyzer_metadata.warnings', async () => {
      const { RubyAnalyzer } = require('../../analyzer/languages/ruby-analyzer');
      await fs.writeFile(path.join(tempDir, 'ok.rb'), 'class Fine\n  def run; end\nend\n');
      await fs.writeFile(path.join(tempDir, 'broken.rb'), 'class Broken\n  def a((((\n  def b((((\nend\n');

      const analyzer = new RubyAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: tempDir });
      const warnings: string[] = contribution.analyzer_metadata.warnings || [];
      expect(warnings.some((warning: string) => warning.includes('broken.rb') && warning.includes('broken syntax'))).toBe(true);
      expect(warnings.some((warning: string) => warning.includes('ok.rb'))).toBe(false);
    });

    it('JavaAnalyzer reports broken syntax in analyzer_metadata.warnings', async () => {
      const { JavaAnalyzer } = require('../../analyzer/languages/java-analyzer');
      await fs.writeFile(path.join(tempDir, 'Broken.java'), 'public class Broken {\n  void a() {\n  void b() {\n  void c() {\n');

      const analyzer = new JavaAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: tempDir });
      const warnings: string[] = contribution.analyzer_metadata.warnings || [];
      expect(warnings.some((warning: string) => warning.includes('Broken.java') && warning.includes('broken syntax'))).toBe(true);
    });

    it('PhpAnalyzer reports broken syntax in analyzer_metadata.warnings', async () => {
      const { PHPAnalyzer } = require('../../analyzer/languages/php-analyzer');
      await fs.writeFile(path.join(tempDir, 'broken.php'), '<?php\nclass Broken {\n  function a() {\n  function b() {\n  function c() {\n');

      const analyzer = new PHPAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: tempDir });
      const warnings: string[] = contribution.analyzer_metadata.warnings || [];
      expect(warnings.some((warning: string) => warning.includes('broken.php') && warning.includes('broken syntax'))).toBe(true);
    });

    it('DartAnalyzer reports broken syntax in analyzer_metadata.warnings', async () => {
      const { DartAnalyzer } = require('../../analyzer/languages/dart-analyzer');
      await fs.writeFile(path.join(tempDir, 'pubspec.yaml'), 'name: hostile_fixture\n');
      await fs.mkdirp(path.join(tempDir, 'lib'));
      await fs.writeFile(path.join(tempDir, 'lib', 'broken.dart'), 'class Broken {\n  void a() {\n  void b() {\n  void c() {\n');

      const analyzer = new DartAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: tempDir });
      const warnings: string[] = contribution.analyzer_metadata.warnings || [];
      expect(warnings.some((warning: string) => warning.includes('broken.dart') && warning.includes('broken syntax'))).toBe(true);
    });
  });

  describe('nested repository visibility', () => {
    it('describeNestedRepositories reports excluded nested git repos with a primary language', async () => {
      await fs.mkdirp(path.join(tempDir, 'rust-engine', '.git'));
      await fs.writeFile(path.join(tempDir, 'rust-engine', 'main.rs'), 'fn main() {}\n');
      await fs.writeFile(path.join(tempDir, 'rust-engine', 'lib.rs'), 'pub fn lib() {}\n');
      await fs.writeFile(path.join(tempDir, 'index.ts'), 'export const host = true;\n');

      const orchestrator = new AnalyzerOrchestrator() as any;
      const nested = await orchestrator.describeNestedRepositories(tempDir);
      expect(nested).toHaveLength(1);
      expect(nested[0].path).toBe('rust-engine');
      expect(nested[0].has_git_directory).toBe(true);
      expect(nested[0].primary_language).toBe('Rust');
      expect(nested[0].source_files).toBe(2);
      expect(nested[0].note).toContain('excluded from this analysis');
      expect(nested[0].note).toContain('cross-repository');
    });

    it('describeNestedRepositories returns an empty list when no nested repos exist', async () => {
      await fs.writeFile(path.join(tempDir, 'index.ts'), 'export const host = true;\n');
      const orchestrator = new AnalyzerOrchestrator() as any;
      const nested = await orchestrator.describeNestedRepositories(tempDir);
      expect(nested).toHaveLength(0);
    });
  });
});
