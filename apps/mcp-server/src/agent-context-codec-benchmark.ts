import * as fs from 'fs-extra';
import * as path from 'path';
import { benchmarkAgentContextCodecs } from './agent-context-codec';

const sampleContext = {
  context_profile: 'first-turn',
  task: 'modify: Replace password auth with OIDC while preserving tenant-scoped sessions',
  selected: {
    name: 'AuthService',
    type: 'service',
    file: 'src/auth/auth.service.ts',
    line: 18,
  },
  files: [
    'src/auth/auth.service.ts',
    'tests/auth/auth.service.test.ts',
    'src/auth/session.repository.ts',
    'src/auth/oidc.client.ts',
  ],
  candidates: [
    'src/auth/auth.controller.ts',
    'src/users/entities/user.entity.ts',
    'src/tenancy/tenant.guard.ts',
  ],
  terms: ['oidc', 'auth', 'tenant', 'session'],
  idioms: [
    'dependency-injection: use constructor-injected collaborators, not inline new clients',
    'auth-tenant-scope: every session must preserve organization and tenant context',
    'testing: focused service tests import production source and mock repository boundaries',
  ],
  risks: [
    'risk high: authentication boundary and session issuance',
    'validate behavioral invariant: tenant id must be present before session creation',
  ],
  reuse: [
    'reuse existing SessionRepository before adding a parallel session store',
    'reuse OidcClient adapter instead of calling provider SDK from AuthService',
  ],
  execution: {
    read: ['src/auth/auth.service.ts', 'src/auth/oidc.client.ts'],
    edit: ['src/auth/auth.service.ts', 'tests/auth/auth.service.test.ts'],
    validate: ['npm test -- tests/auth/auth.service.test.ts', 'npm run typecheck'],
  },
  rule: 'Read files in order. Preserve idioms. Expand only if blocked by source evidence or validation failure.',
};

const report = benchmarkAgentContextCodecs(sampleContext);
const args = parseArgs(process.argv.slice(2));

if (args.output) {
  fs.ensureDirSync(path.dirname(args.output));
  fs.writeJsonSync(args.output, report, { spaces: 2 });
}
if (args.markdown) {
  fs.ensureDirSync(path.dirname(args.markdown));
  fs.writeFileSync(args.markdown, renderMarkdown(report));
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status !== 'pass') process.exitCode = 1;

function parseArgs(argv: string[]): { output: string | null; markdown: string | null } {
  let output: string | null = path.resolve(process.cwd(), '.klauro-agent-context-codec-benchmark/latest-report.json');
  let markdown: string | null = path.resolve(process.cwd(), '.klauro-agent-context-codec-benchmark/latest-report.md');
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') output = path.resolve(argv[++index]);
    else if (arg === '--markdown') markdown = path.resolve(argv[++index]);
    else if (arg === '--no-output') output = null;
    else if (arg === '--no-markdown') markdown = null;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        'Usage: npm run agent-context-codec-benchmark -- [options]',
        '',
        'Options:',
        '  --output path      Write JSON report (default .klauro-agent-context-codec-benchmark/latest-report.json)',
        '  --markdown path    Write Markdown report (default .klauro-agent-context-codec-benchmark/latest-report.md)',
        '  --no-output        Do not write JSON report',
        '  --no-markdown      Do not write Markdown report',
      ].join('\n') + '\n');
      process.exit(0);
    }
  }
  return { output, markdown };
}

function renderMarkdown(report: ReturnType<typeof benchmarkAgentContextCodecs>): string {
  const lines = [
    '# Klauro Agent Context Codec Benchmark',
    '',
    `Status: **${report.status.toUpperCase()}** (${report.score}/100)`,
    `Recommendation: \`${report.recommendation}\``,
    '',
    '## Gates',
    '',
    '| Gate | Status | Detail |',
    '| --- | --- | --- |',
    ...report.gates.map(gate => `| \`${gate.id}\` | ${gate.status} | ${escapeMd(gate.detail)} |`),
    '',
    '## Results',
    '',
    '| Format | Tokens | Token Reduction | Slots / 100 Tokens | Balanced | Prompt Native | Validation Fidelity |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
    ...report.results.map(result => [
      `| \`${result.name}\``,
      `${result.estimated_tokens} / ${result.promptish_tokens}`,
      `${result.token_reduction_vs_min_json}% / ${result.promptish_token_reduction_vs_min_json}%`,
      `${result.context_slots_per_100_tokens} / ${result.context_slots_per_100_promptish_tokens}`,
      result.balanced_score,
      result.prompt_native,
      `${result.validation_fidelity} |`,
    ].join(' | ')),
    '',
    'Token columns are `chars/4 estimate / promptish lexical estimate`. The promptish estimate counts words, numbers, path punctuation, and delimiters so compact opcode formats do not win only because character count is low.',
    '',
    '## Winning Sample',
    '',
    '```text',
    report.results.find(result => result.name === report.recommendation)?.sample || '',
    '```',
    '',
  ];
  return lines.join('\n');
}

function escapeMd(value: unknown): string {
  return String(value || '').replace(/\|/g, '\\|');
}
