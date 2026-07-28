import { AnalysisContext, BaseAnalyzer, FileAnalysisContext, FileAnalysisResult } from '../core/base-analyzer';
import { CASEntryPoint, CASNode } from '../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../core/glob-cache';

/**
 * CLI/script codebase type: entry points rooted at a command/subcommand rather than
 * a route. Covers the major CLI frameworks across languages so `get_flow_concepts`
 * / `get_entry_points` can root flows at the real invocation surface:
 *   - Python: Click (@click.command/@click.group), argparse (add_parser/add_argument),
 *     Typer (@app.command)
 *   - Node/TS: Commander (program.command('x').action(...)), yargs (.command()), oclif (command classes)
 *   - Go: cobra (&cobra.Command{Use, Run}, AddCommand), urfave/cli
 *   - Rust: clap (#[derive(Parser)], #[command(subcommand)])
 *   - Ruby: Thor (desc + method)
 *   - generic: main()/if __name__=='__main__'/func main() when no framework is detected
 *
 * This is a cross-language, regex/text-based pass (mirrors DistributionArtifactAnalyzer /
 * ShellAnalyzer) — it does not replace the per-language analyzers' own call-graph
 * extraction, it adds `cli`/`command` entry points resolved to a handler name so a
 * subcommand becomes a real flow root.
 */

type CliFramework =
  | 'click' | 'argparse' | 'typer'
  | 'commander' | 'yargs' | 'oclif'
  | 'cobra' | 'urfave-cli'
  | 'clap'
  | 'thor'
  | 'generic';

interface ParsedCliCommand {
  name: string;
  framework: CliFramework;
  line: number;
  handler?: string;
  isGroup?: boolean;
  parentGroup?: string;
  args?: string[];
}

interface CliFileResult {
  relativePath: string;
  fullPath: string;
  commands: ParsedCliCommand[];
  frameworksDetected: Set<CliFramework>;
}

const CANDIDATE_GLOBS = [
  '**/*.py',
  '**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.cjs',
  '**/*.go',
  '**/*.rs',
  '**/*.rb',
];

const FRAMEWORK_SIGNALS: Record<Exclude<CliFramework, 'generic'>, RegExp> = {
  click: /\bimport\s+click\b|\bfrom\s+click\b|@click\.(command|group)\b/,
  argparse: /\bimport\s+argparse\b|argparse\.ArgumentParser\s*\(/,
  typer: /\bimport\s+typer\b|\btyper\.Typer\s*\(/,
  commander: /require\(\s*['"]commander['"]\s*\)|from\s+['"]commander['"]/,
  yargs: /require\(\s*['"]yargs['"]\s*\)|from\s+['"]yargs['"]/,
  oclif: /from\s+['"]@oclif\/core['"]|extends\s+Command\b/,
  cobra: /["']github\.com\/spf13\/cobra["']|cobra\.Command\b/,
  'urfave-cli': /["']github\.com\/urfave\/cli(\/v2)?["']/,
  clap: /\bclap::/,
  thor: /\bclass\s+\w+\s*<\s*Thor\b|require\s+['"]thor['"]/,
};

export class CliAnalyzer extends BaseAnalyzer {
  constructor() {
    super('cli-frameworks', 'CLI/Script Entry Point Analyzer', '1.0.0', 'language');
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const files = await this.getRelevantFiles(projectPath);
    if (files.length === 0) return false;
    // Cheap gate: at least one candidate file must contain a framework signal or a
    // generic main entry marker, otherwise this analyzer has nothing to contribute.
    for (const relativePath of files.slice(0, 500)) {
      let content: string;
      try {
        content = await fs.readFile(path.join(projectPath, relativePath), 'utf-8');
      } catch {
        continue;
      }
      if (this.hasAnySignal(content)) return true;
    }
    return false;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await glob(CANDIDATE_GLOBS, {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    return files.sort();
  }

  private hasAnySignal(content: string): boolean {
    for (const re of Object.values(FRAMEWORK_SIGNALS)) {
      if (re.test(content)) return true;
    }
    return this.hasGenericEntry(content);
  }

  private hasGenericEntry(content: string): boolean {
    return /if\s+__name__\s*==\s*['"]__main__['"]/.test(content) ||
      /func\s+main\s*\(\s*\)/.test(content) ||
      /fn\s+main\s*\(\s*\)/.test(content);
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    const result = this.parseCliFile(context.relativePath, context.filePath, content);
    this.emitEntryPoints(result, nodes, entryPoints);

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      [],
      entryPoints,
      [],
      [],
      result.commands.map(c => c.name)
    );
  }

  async analyze(context: AnalysisContext) {
    this.resetAnalysisWarnings();
    const nodes: CASNode[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const frameworksSeen = new Set<CliFramework>();
    let filesWithCommands = 0;

    let files = await this.getRelevantFiles(context.projectPath);
    files = this.capAndPrioritizeSourceFiles(files, 'CLI candidate files');

    for (const relativePath of files) {
      const fullPath = path.join(context.projectPath, relativePath);
      let content = '';
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }
      if (!this.hasAnySignal(content)) continue;

      const result = this.parseCliFile(relativePath, fullPath, content);
      if (result.commands.length === 0) continue;

      filesWithCommands++;
      for (const fw of result.frameworksDetected) frameworksSeen.add(fw);
      this.emitEntryPoints(result, nodes, entryPoints);
    }

    const warnings = this.collectAnalysisWarnings();
    return this.createContribution(nodes, [], entryPoints, [], {
      ...(warnings.length > 0 ? { warnings } : {}),
      framework_specific: {
        cliFrameworksDetected: Array.from(frameworksSeen).sort(),
        filesWithCliCommands: filesWithCommands,
        commandsFound: entryPoints.length,
      }
    });
  }

  // ── Parsing dispatch ─────────────────────────────────────────────────────

  private parseCliFile(relativePath: string, fullPath: string, content: string): CliFileResult {
    const commands: ParsedCliCommand[] = [];
    const frameworksDetected = new Set<CliFramework>();

    const ext = path.extname(relativePath);
    if (ext === '.py') {
      this.parsePython(content, commands, frameworksDetected);
    } else if (['.ts', '.tsx', '.js', '.mjs', '.cjs'].includes(ext)) {
      this.parseNode(content, commands, frameworksDetected);
    } else if (ext === '.go') {
      this.parseGo(content, commands, frameworksDetected);
    } else if (ext === '.rs') {
      this.parseRust(content, commands, frameworksDetected);
    } else if (ext === '.rb') {
      this.parseRuby(content, commands, frameworksDetected);
    }

    if (commands.length === 0 && this.hasGenericEntry(content)) {
      this.parseGeneric(relativePath, content, commands, frameworksDetected);
    }

    return { relativePath, fullPath, commands, frameworksDetected };
  }

  // ── Python: Click, argparse, Typer ───────────────────────────────────────

  private parsePython(content: string, commands: ParsedCliCommand[], frameworks: Set<CliFramework>): void {
    const lines = content.split('\n');

    // Click / Typer: decorator directly above a `def name(...)`.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      const clickCommand = line.match(/^@(\w+)\.command\s*\(/);
      const clickGroup = line.match(/^@(\w+)\.group\s*\(/);
      const typerCommand = line.match(/^@(\w+)\.command\s*\(/); // same shape as click's
      const bareClickCommand = /^@click\.command\b/.test(line);
      const bareClickGroup = /^@click\.group\b/.test(line);

      const isClickLike = clickCommand || clickGroup || bareClickCommand || bareClickGroup;
      if (!isClickLike) continue;

      // Find the following `def name(` within a few lines (allow stacked decorators/options).
      let handlerLine = -1;
      let handlerName: string | undefined;
      for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
        const defMatch = lines[j].match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/);
        if (defMatch) {
          handlerLine = j;
          handlerName = defMatch[1];
          break;
        }
        // Stop scanning if we hit a non-decorator, non-blank statement first.
        if (lines[j].trim() && !lines[j].trim().startsWith('@')) break;
      }
      if (!handlerName) continue;

      const nameOptMatch = line.match(/name\s*=\s*["']([^"']+)["']/);
      const commandName = nameOptMatch ? nameOptMatch[1] : handlerName.replace(/_/g, '-');
      const isGroup = Boolean(clickGroup || bareClickGroup);

      frameworks.add('click');
      if (/typer/i.test(content) && /@app\.command/.test(line)) frameworks.add('typer');

      commands.push({
        name: commandName,
        framework: frameworks.has('typer') && /@app\.command/.test(line) ? 'typer' : 'click',
        line: handlerLine + 1,
        handler: handlerName,
        isGroup,
      });
    }

    // argparse: subparsers.add_parser("name", ...) followed eventually by
    // `<var>.set_defaults(func=handler)`.
    if (/argparse\.ArgumentParser\s*\(/.test(content)) {
      frameworks.add('argparse');
      const parserVarToName = new Map<string, { name: string; line: number }>();
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/(\w+)\s*=\s*\w+\.add_parser\s*\(\s*["']([^"']+)["']/);
        if (m) parserVarToName.set(m[1], { name: m[2], line: i + 1 });
      }
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/(\w+)\.set_defaults\s*\(\s*func\s*=\s*(\w+)/);
        if (m) {
          const info = parserVarToName.get(m[1]);
          if (info) {
            commands.push({
              name: info.name,
              framework: 'argparse',
              line: info.line,
              handler: m[2],
            });
          }
        }
      }
    }
  }

  // ── Node/TS: Commander, yargs, oclif ─────────────────────────────────────

  private parseNode(content: string, commands: ParsedCliCommand[], frameworks: Set<CliFramework>): void {
    const lines = content.split('\n');

    if (FRAMEWORK_SIGNALS.commander.test(content)) {
      frameworks.add('commander');
      // program.command('name <arg>').description(...).action(handler)
      // Scan a bounded window of lines after `.command(` for a chained `.action(`.
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/\.command\s*\(\s*["']([^"']+)["']/);
        if (!m) continue;
        const rawName = m[1].split(/\s+/)[0]; // strip "<arg>"/"[opt]" usage tail
        let handler: string | undefined;
        let actionLine = i;
        for (let j = i; j < Math.min(i + 20, lines.length); j++) {
          const am = lines[j].match(/\.action\s*\(\s*(?:async\s*)?(?:function\s*)?\(?([\w.]*)/);
          if (lines[j].includes('.action(')) {
            actionLine = j;
            handler = am && am[1] ? am[1] : undefined;
            break;
          }
        }
        commands.push({
          name: rawName,
          framework: 'commander',
          line: actionLine + 1,
          handler,
        });
      }
    }

    if (FRAMEWORK_SIGNALS.yargs.test(content)) {
      frameworks.add('yargs');
      // .command('name', 'description', builder, handler) or .command({ command, handler })
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/\.command\s*\(\s*["']([^"']+)["']/);
        if (m) {
          const rawName = m[1].split(/\s+/)[0];
          commands.push({ name: rawName, framework: 'yargs', line: i + 1 });
          continue;
        }
        // object form: `command: 'name'`
        const objectForm = lines[i].match(/command\s*:\s*["']([^"']+)["']/);
        if (objectForm && /yargs/i.test(content)) {
          const rawName = objectForm[1].split(/\s+/)[0];
          commands.push({ name: rawName, framework: 'yargs', line: i + 1 });
        }
      }
    }

    if (FRAMEWORK_SIGNALS.oclif.test(content)) {
      frameworks.add('oclif');
      // oclif command classes: `export default class Build extends Command { ... static description ... async run() }`
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^export\s+default\s+class\s+(\w+)\s+extends\s+Command\b/);
        if (m) {
          commands.push({
            name: this.pascalToKebab(m[1]),
            framework: 'oclif',
            line: i + 1,
            handler: 'run',
          });
        }
      }
    }
  }

  private pascalToKebab(name: string): string {
    return name
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
      .toLowerCase();
  }

  // ── Go: cobra, urfave/cli ────────────────────────────────────────────────

  private parseGo(content: string, commands: ParsedCliCommand[], frameworks: Set<CliFramework>): void {
    const lines = content.split('\n');

    if (FRAMEWORK_SIGNALS.cobra.test(content)) {
      frameworks.add('cobra');
      // var xCmd = &cobra.Command{ Use: "name ...", Run/RunE: handler, }
      // Scan blocks between `&cobra.Command{` and the matching `}`.
      // A command is a "group" only when some other command is registered under it
      // via `xCmd.AddCommand(...)` — a bare leaf command is a real, flow-rootable entry.
      const varsWithChildren = new Set<string>();
      for (const m of content.matchAll(/\b(\w+)\.AddCommand\s*\(/g)) {
        varsWithChildren.add(m[1]);
      }

      for (let i = 0; i < lines.length; i++) {
        const varMatch = lines[i].match(/\b(\w+)\s*(?::)?=\s*&cobra\.Command\s*\{/);
        if (!varMatch) continue;
        const varName = varMatch[1];
        let use: string | undefined;
        let handler: string | undefined;
        for (let j = i; j < Math.min(i + 40, lines.length); j++) {
          const useMatch = lines[j].match(/Use:\s*["']([^"']+)["']/);
          if (useMatch) use = useMatch[1].split(/\s+/)[0];
          const runMatch = lines[j].match(/Run(?:E)?:\s*(\w+)/);
          if (runMatch) handler = runMatch[1];
          if (/^\s*\}/.test(lines[j]) && j > i) break;
        }
        if (use) {
          commands.push({
            name: use,
            framework: 'cobra',
            line: i + 1,
            handler,
            isGroup: varsWithChildren.has(varName),
          });
        }
      }
    }

    if (FRAMEWORK_SIGNALS['urfave-cli'].test(content)) {
      frameworks.add('urfave-cli');
      // cli.Command{ Name: "name", Action: handler }
      for (let i = 0; i < lines.length; i++) {
        if (!/cli\.Command\s*\{/.test(lines[i])) continue;
        let name: string | undefined;
        let handler: string | undefined;
        for (let j = i; j < Math.min(i + 40, lines.length); j++) {
          const nameMatch = lines[j].match(/Name:\s*["']([^"']+)["']/);
          if (nameMatch) name = nameMatch[1];
          const actionMatch = lines[j].match(/Action:\s*(\w+)/);
          if (actionMatch) handler = actionMatch[1];
          if (/^\s*\}/.test(lines[j]) && j > i) break;
        }
        if (name) {
          commands.push({ name, framework: 'urfave-cli', line: i + 1, handler });
        }
      }
    }
  }

  // ── Rust: clap ────────────────────────────────────────────────────────────

  private parseRust(content: string, commands: ParsedCliCommand[], frameworks: Set<CliFramework>): void {
    if (!FRAMEWORK_SIGNALS.clap.test(content)) return;
    frameworks.add('clap');
    const lines = content.split('\n');

    // #[derive(Parser)] ... struct/enum Name { ... #[command(subcommand)] ... }
    // Subcommands are typically an enum with #[derive(Subcommand)] and variants
    // annotated (or bare) — each variant name is a subcommand.
    for (let i = 0; i < lines.length; i++) {
      if (!/#\[derive\([^)]*Subcommand[^)]*\)\]/.test(lines[i])) continue;
      // Find the enum declaration within the next few lines.
      let enumLine = -1;
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (/^\s*(?:pub\s+)?enum\s+(\w+)/.test(lines[j])) {
          enumLine = j;
          break;
        }
      }
      if (enumLine === -1) continue;
      // Walk variants until the closing brace of the enum.
      let depth = 0;
      let started = false;
      for (let j = enumLine; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') { depth++; started = true; }
          else if (ch === '}') depth--;
        }
        const variantMatch = lines[j].match(/^\s*(\w+)\s*(?:\{|\(|,)/);
        if (started && depth >= 1 && variantMatch && !/^(enum|pub|derive|#)/.test(variantMatch[1])) {
          const variant = variantMatch[1];
          if (variant && /^[A-Z]/.test(variant)) {
            commands.push({
              name: this.pascalToKebab(variant),
              framework: 'clap',
              line: j + 1,
              handler: variant,
            });
          }
        }
        if (started && depth <= 0) break;
      }
    }

    // Top-level `#[derive(Parser)] struct Cli { ... }` with no subcommand enum:
    // treat the binary itself as a single flat CLI command (name from #[command(name = "...")]).
    if (commands.length === 0 && /#\[derive\([^)]*Parser[^)]*\)\]/.test(content)) {
      const nameMatch = content.match(/#\[command\([^)]*name\s*=\s*"([^"]+)"/);
      const structMatch = content.match(/#\[derive\([^)]*Parser[^)]*\)\][\s\S]{0,80}?struct\s+(\w+)/);
      if (structMatch) {
        const idx = content.indexOf(structMatch[0]);
        const line = content.slice(0, idx).split('\n').length;
        commands.push({
          name: nameMatch ? nameMatch[1] : this.pascalToKebab(structMatch[1]),
          framework: 'clap',
          line,
          handler: structMatch[1],
        });
      }
    }
  }

  // ── Ruby: Thor ────────────────────────────────────────────────────────────

  private parseRuby(content: string, commands: ParsedCliCommand[], frameworks: Set<CliFramework>): void {
    if (!FRAMEWORK_SIGNALS.thor.test(content)) return;
    frameworks.add('thor');
    const lines = content.split('\n');

    // desc "name ARGS", "description" followed by `def name(...)`
    for (let i = 0; i < lines.length; i++) {
      const descMatch = lines[i].match(/^\s*desc\s+["']([^"'\s]+)/);
      if (!descMatch) continue;
      let handlerLine = -1;
      let handlerName: string | undefined;
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const defMatch = lines[j].match(/^\s*def\s+(\w+)/);
        if (defMatch) {
          handlerLine = j;
          handlerName = defMatch[1];
          break;
        }
        if (lines[j].trim() && !/^\s*(map|method_option|long_desc)/.test(lines[j])) break;
      }
      if (!handlerName) continue;
      commands.push({
        name: descMatch[1],
        framework: 'thor',
        line: handlerLine + 1,
        handler: handlerName,
      });
    }
  }

  // ── Generic fallback: main() with no known framework ────────────────────

  private parseGeneric(relativePath: string, content: string, commands: ParsedCliCommand[], frameworks: Set<CliFramework>): void {
    const lines = content.split('\n');
    const ext = path.extname(relativePath);

    if (ext === '.py') {
      const idx = lines.findIndex(l => /if\s+__name__\s*==\s*['"]__main__['"]/.test(l));
      if (idx !== -1) {
        frameworks.add('generic');
        commands.push({ name: 'main', framework: 'generic', line: idx + 1, handler: 'main' });
      }
      return;
    }
    if (ext === '.go') {
      const idx = lines.findIndex(l => /func\s+main\s*\(\s*\)/.test(l));
      if (idx !== -1 && /package\s+main\b/.test(content)) {
        frameworks.add('generic');
        commands.push({ name: 'main', framework: 'generic', line: idx + 1, handler: 'main' });
      }
      return;
    }
    if (ext === '.rs') {
      const idx = lines.findIndex(l => /fn\s+main\s*\(\s*\)/.test(l));
      if (idx !== -1) {
        frameworks.add('generic');
        commands.push({ name: 'main', framework: 'generic', line: idx + 1, handler: 'main' });
      }
      return;
    }
  }

  // ── Emission ──────────────────────────────────────────────────────────────

  private emitEntryPoints(result: CliFileResult, nodes: CASNode[], entryPoints: CASEntryPoint[]): void {
    const fileId = `file_${this.sanitizeId(result.relativePath)}`;
    const seen = new Set<string>();

    if (result.commands.length > 0 && !nodes.some(node => node.id === fileId)) {
      nodes.push(this.createNode(
        fileId,
        path.basename(result.relativePath),
        'file',
        1,
        result.fullPath,
        1,
        undefined,
        {
          relativePath: result.relativePath,
          extension: path.extname(result.relativePath),
          cliFrameworks: [...result.frameworksDetected].sort(),
        },
      ));
    }

    for (const cmd of result.commands) {
      const key = `${cmd.name}:${cmd.line}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const entryId = `entry_cli_${this.sanitizeId(result.relativePath)}_${this.sanitizeId(cmd.name)}_${cmd.line}`;
      const args = (cmd.args || []).map(a => ({ name: a, type: 'string', required: false, location: 'argv' }));

      entryPoints.push(this.createEntryPoint(
        entryId,
        fileId,
        'cli',
        cmd.isGroup ? `${cmd.name} (command group)` : cmd.name,
        `CLI ${cmd.isGroup ? 'command group' : 'subcommand'} "${cmd.name}"${cmd.handler ? ` -> ${cmd.handler}()` : ''} (${cmd.framework})`,
        {
          pattern: cmd.name,
          parameters: args.length > 0 ? args : undefined,
        },
        undefined,
        {
          framework: cmd.framework,
          kind: cmd.isGroup ? 'command-group' : 'command',
          file: result.relativePath,
          line: cmd.line,
          command: cmd.name,
          handler: cmd.handler,
        },
        cmd.handler ? {
          node_id: `function_${this.sanitizeId(result.relativePath)}_${this.sanitizeId(cmd.handler)}`,
          method_name: cmd.handler,
          file: result.relativePath,
          line: cmd.line,
        } : undefined
      ));
    }
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'system';
      case 2: return 'architectural';
      case 3: return 'code';
      case 4: return 'member';
      case 5: return 'implementation';
      default: return `level_${level}`;
    }
  }

  protected getCapabilities(): string[] {
    return [
      'cli-framework-detection',
      'subcommand-extraction',
      'click-support',
      'argparse-support',
      'typer-support',
      'commander-support',
      'yargs-support',
      'oclif-support',
      'cobra-support',
      'urfave-cli-support',
      'clap-support',
      'thor-support',
      'generic-main-entry-detection',
    ];
  }
}
