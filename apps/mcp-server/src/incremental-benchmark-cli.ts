import * as os from 'os';
import * as path from 'path';

export interface IncrementalBenchmarkCliOptions {
  repos: Array<{ name?: string; path: string }>;
  includeRealRepos: boolean;
  devRoot: string;
  maxTargets: number;
  workRoot: string;
  outputPath: string;
  markdownPath: string;
  keepWorkspaces: boolean;
  verifyFull: boolean;
  useGitBaseline: boolean;
  concurrency: number;
  analysisPath: 'in-process-harness' | 'klauro-product';
  analyzerServerUrl?: string;
}

export function defaultIncrementalBenchmarkWorkRoot(): string {
  return path.join(os.tmpdir(), 'klauro-incremental-benchmark-workspaces');
}

export function parseIncrementalBenchmarkCli(argv: string[]): IncrementalBenchmarkCliOptions {
  const options: IncrementalBenchmarkCliOptions = {
    repos: [],
    includeRealRepos: false,
    devRoot: path.join(process.env.HOME || '', 'dev'),
    maxTargets: 6,
    workRoot: defaultIncrementalBenchmarkWorkRoot(),
    outputPath: path.join(process.cwd(), '.klauro-incremental-benchmark', 'latest-report.json'),
    markdownPath: path.join(process.cwd(), '.klauro-incremental-benchmark', 'latest-report.md'),
    keepWorkspaces: false,
    verifyFull: true,
    useGitBaseline: false,
    concurrency: 1,
    analysisPath: 'in-process-harness',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => requiredOptionValue(argument, argv[++index]);
    if (argument === '--repo') {
      const repository = value();
      const separator = repository.indexOf('=');
      const name = separator >= 0 ? repository.slice(0, separator) : undefined;
      const repositoryPath = separator >= 0 ? repository.slice(separator + 1) : repository;
      options.repos.push({ name: name || undefined, path: path.resolve(repositoryPath) });
    } else if (argument === '--real-repos') options.includeRealRepos = true;
    else if (argument === '--dev-root') options.devRoot = path.resolve(value());
    else if (argument === '--max-targets') options.maxTargets = Number(value());
    else if (argument === '--work-root') options.workRoot = path.resolve(value());
    else if (argument === '--output') options.outputPath = path.resolve(value());
    else if (argument === '--markdown') options.markdownPath = path.resolve(value());
    else if (argument === '--discard-workspaces') options.keepWorkspaces = false;
    else if (argument === '--keep-workspaces') options.keepWorkspaces = true;
    else if (argument === '--verify-full') options.verifyFull = true;
    else if (argument === '--no-verify-full') options.verifyFull = false;
    else if (argument === '--git-baseline') options.useGitBaseline = true;
    else if (argument === '--concurrency') options.concurrency = Number(value());
    else if (argument === '--analysis-path') options.analysisPath = parseAnalysisPath(value());
    else if (argument === '--analyzer-server') options.analyzerServerUrl = value();
    else if (argument === '--help' || argument === '-h') printIncrementalBenchmarkHelp();
    else throw new Error(`Unknown incremental benchmark option "${argument}"`);
  }
  if (!Number.isInteger(options.maxTargets) || options.maxTargets < 1) throw new Error('--max-targets must be a positive integer');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error('--concurrency must be a positive integer');
  return options;
}

function requiredOptionValue(option: string, value?: string): string {
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function parseAnalysisPath(value: string): IncrementalBenchmarkCliOptions['analysisPath'] {
  if (value === 'klauro-product' || value === 'in-process-harness') return value;
  throw new Error(`Invalid incremental benchmark analysis path "${value}". Expected klauro-product or in-process-harness.`);
}

function printIncrementalBenchmarkHelp(): never {
  console.log([
    'Usage: npm run incremental-benchmark -- [options]',
    '',
    'Options:',
    '  --repo name=/path/to/repo     Benchmark a specific repo. May be repeated.',
    '  --real-repos                  Include discovered repos under --dev-root.',
    '  --dev-root /path              Root used for real repo discovery.',
    '  --max-targets n               Limit total targets.',
    '  --work-root /path             Directory for copied repo workspaces and isolated storage.',
    '  --verify-full                 Run a fresh full analysis after the edit and compare parity.',
    '  --no-verify-full              Skip the fresh full analysis parity check.',
    '  --git-baseline                Initialize and commit a git baseline in copied repos.',
    '  --concurrency n               Number of repos to benchmark concurrently.',
    '  --analysis-path path          Analysis path: klauro-product or in-process-harness.',
    '  --analyzer-server url         Hosted analyzer URL used by the klauro-product path.',
    '  --discard-workspaces          Remove copied repos after writing the report.',
    '  --keep-workspaces             Keep copied repos for debugging.',
    '  --output /path/report.json    Write JSON report.',
    '  --markdown /path/report.md    Write Markdown report.',
  ].join('\n'));
  process.exit(0);
}
