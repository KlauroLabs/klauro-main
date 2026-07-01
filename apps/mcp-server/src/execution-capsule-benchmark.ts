import * as fs from 'fs-extra';
import * as path from 'path';
import { performance } from 'perf_hooks';
import * as zlib from 'zlib';
import { formatExecutionCapsule } from './agent-adoption';

type Candidate = {
  name: string;
  encode: () => string;
  agentReadable: number;
  actionability: number;
  exactPaths: number;
  promptNative: number;
};

type Result = {
  name: string;
  bytes: number;
  estimated_tokens: number;
  token_reduction_vs_json: number;
  encode_ms_per_1000: number;
  agent_readable: number;
  actionability: number;
  exact_paths: number;
  prompt_native: number;
  balanced_score: number;
  sample: string;
};

const samples = [
  {
    mode: 'direct-patch',
    task_type: 'modify',
    target: 'Fix N+1 project summary lookup without changing contracts',
    read_first: ['src/services/taskSummaryService.ts', 'tests/taskSummaryService.test.ts', 'src/repositories/projectRepository.ts'],
    edit_scope: ['src/services/taskSummaryService.ts', 'tests/taskSummaryService.test.ts'],
    do: [
      'derive unique projectIds with [...new Set(tasks.map(task => task.projectId))]',
      'call projects.findByIds once',
      'build projectById map and map tasks synchronously',
    ],
    ops: [
      {
        file: 'src/services/taskSummaryService.ts',
        op: 'summarize: ids=uniq(tasks.projectId) > projectList=await projects.findByIds(ids) > byId=Map(projectList.id) > return sync map',
      },
      {
        file: 'tests/taskSummaryService.test.ts',
        op: 'assert+TaskSummaryService only; repo={findById:idCalls++,findByIds:idsCalls++/capture}; tasks p1,p2,p1; assert idCalls=0 idsCalls=1 capturedIds.length=2 result.length=3',
      },
    ],
    test: ['findByIds once', 'findById zero', '2 unique project ids'],
    no: ['package.json', 'controller edit', 'repository edit', 'Jest globals'],
    preserve: ['service/repository boundary', 'public summary contract', 'test imports production source'],
    validate: ['node /tmp/validator.cjs'],
    token_policy: { source_files: 2, final_response_words: 40 },
    stop_rule: 'After validation, stop.',
  },
  {
    mode: 'minimal-execution',
    task_type: 'modify',
    target: 'Replace password auth with OIDC while preserving session boundary',
    read_first: ['src/auth/authService.ts', 'src/auth/oidcClient.ts', 'src/auth/sessionRepository.ts', 'tests/authService.test.js'],
    edit_scope: ['src/auth/authService.ts', 'tests/authService.test.js'],
    do: ['verify id token through OidcClient', 'create session through existing SessionRepository'],
    ops: [
      {
        file: 'src/auth/authService.ts',
        op: 'verify token via OidcClient > create session through existing SessionRepository',
      },
      {
        file: 'tests/authService.test.js',
        op: 'assert OIDC accepted, password verifier removed, session repo reused',
      },
    ],
    test: ['OIDC token accepted', 'password verifier removed', 'session repository not replaced'],
    no: ['new SessionRepository', 'passwords.verify', 'sessionRepository edit'],
    preserve: ['auth module boundary', 'tenant/session scope'],
    validate: ['npm test -- tests/authService.test.js'],
    token_policy: { source_files: 4, final_response_words: 80 },
  },
];

export function benchmarkExecutionCapsuleFormats(): { generated_at: string; results: Result[]; recommendation: string } {
  const candidates = buildCandidates(samples);
  const jsonTokens = estimateTokens(JSON.stringify(samples));
  const results = candidates
    .map(candidate => {
      const timing = timeEncoder(candidate.encode);
      const output = candidate.encode();
      const estimatedTokens = estimateTokens(output);
      const tokenReduction = percentReduction(jsonTokens, estimatedTokens);
      const balancedScore = Math.round(
        tokenReduction * 0.34 +
        candidate.agentReadable * 0.18 +
        candidate.actionability * 0.20 +
        candidate.exactPaths * 0.14 +
        candidate.promptNative * 0.10 +
        Math.max(0, 100 - timing.msPer1000) * 0.04
      );
      return {
        name: candidate.name,
        bytes: Buffer.byteLength(output),
        estimated_tokens: estimatedTokens,
        token_reduction_vs_json: tokenReduction,
        encode_ms_per_1000: Math.round(timing.msPer1000 * 100) / 100,
        agent_readable: candidate.agentReadable,
        actionability: candidate.actionability,
        exact_paths: candidate.exactPaths,
        prompt_native: candidate.promptNative,
        balanced_score: balancedScore,
        sample: output.slice(0, 700),
      };
    })
    .sort((a, b) => b.balanced_score - a.balanced_score || a.estimated_tokens - b.estimated_tokens);
  return {
    generated_at: new Date().toISOString(),
    results,
    recommendation: results[0]?.name || 'unknown',
  };
}

function buildCandidates(values: any[]): Candidate[] {
  const minJson = () => JSON.stringify(values);
  const compactJson = () => JSON.stringify(values.map(value => ({
    m: value.mode,
    t: value.task_type,
    q: value.target,
    r: value.read_first,
    e: value.edit_scope,
    o: value.ops,
    d: value.do,
    x: value.no,
    p: value.preserve,
    v: value.validate,
  })));
  const jsonlOps = () => values.map(value => [
    `T ${value.task_type} ${value.target}`,
    ...(value.read_first || []).map((item: string) => `R ${item}`),
    ...(value.edit_scope || []).map((item: string) => `E ${item}`),
    ...(value.ops || []).map((item: any) => `O ${item.file} ${item.op}`),
    ...(value.do || []).map((item: string) => `D ${item}`),
    ...(value.test || []).map((item: string) => `TST ${item}`),
    ...(value.no || []).map((item: string) => `X ${item}`),
    ...(value.validate || []).map((item: string) => `V ${item}`),
  ].join('\n')).join('\n---\n');
  const sexpr = () => values.map(value => [
    `(task ${value.task_type} "${short(value.target)}"`,
    `  (files ${[...(value.read_first || []), ...(value.edit_scope || [])].map((item: string) => `"${item}"`).join(' ')})`,
    `  (ops ${(value.ops || []).map((item: any) => `("${item.file}" "${short(item.op)}")`).join(' ')})`,
    `  (avoid ${(value.no || []).map((item: string) => `"${short(item)}"`).join(' ')})`,
    `  (validate ${(value.validate || []).map((item: string) => `"${item}"`).join(' ')}))`,
  ].join('\n')).join('\n');
  const protoText = () => values.map(value => [
    `context { task: "${value.task_type}" target: "${short(value.target)}"`,
    ...(value.read_first || []).map((item: string) => `  read: "${item}"`),
    ...(value.edit_scope || []).map((item: string) => `  edit: "${item}"`),
    ...(value.ops || []).map((item: any) => `  op { file: "${item.file}" text: "${short(item.op)}" }`),
    ...(value.validate || []).map((item: string) => `  validate: "${item}"`),
    `}`,
  ].join('\n')).join('\n');
  const k4 = () => values.map(formatLegacyExecutionCapsule).join('\n--\n');
  const k5 = () => values.map(formatExecutionCapsule).join('\n--\n');
  const uri = () => values.map(value => [
    `k3://${short(value.task_type)}/${encodeURIComponent(short(value.target))}`,
    `?r=${encodeURIComponent((value.read_first || []).join(','))}`,
    `&e=${encodeURIComponent((value.edit_scope || []).join(','))}`,
    `&d=${encodeURIComponent((value.do || []).map(short).join(';'))}`,
    `&x=${encodeURIComponent((value.no || []).map(short).join(';'))}`,
  ].join('')).join('\n');
  const gzipJson = () => zlib.gzipSync(Buffer.from(minJson())).toString('base64');
  const gzipK5 = () => zlib.gzipSync(Buffer.from(k5())).toString('base64');
  return [
    { name: 'min-json', encode: minJson, agentReadable: 75, actionability: 68, exactPaths: 100, promptNative: 92 },
    { name: 'short-key-json', encode: compactJson, agentReadable: 65, actionability: 70, exactPaths: 100, promptNative: 88 },
    { name: 'jsonl-opcodes', encode: jsonlOps, agentReadable: 88, actionability: 86, exactPaths: 100, promptNative: 95 },
    { name: 's-expression', encode: sexpr, agentReadable: 70, actionability: 74, exactPaths: 100, promptNative: 82 },
    { name: 'protobuf-text', encode: protoText, agentReadable: 78, actionability: 80, exactPaths: 100, promptNative: 86 },
    { name: 'kec4', encode: k4, agentReadable: 90, actionability: 92, exactPaths: 100, promptNative: 96 },
    { name: 'kec5', encode: k5, agentReadable: 91, actionability: 94, exactPaths: 100, promptNative: 97 },
    { name: 'uri-opcodes', encode: uri, agentReadable: 62, actionability: 64, exactPaths: 100, promptNative: 60 },
    { name: 'gzip-json-base64', encode: gzipJson, agentReadable: 5, actionability: 8, exactPaths: 100, promptNative: 5 },
    { name: 'gzip-kec5-base64', encode: gzipK5, agentReadable: 5, actionability: 8, exactPaths: 100, promptNative: 5 },
  ];
}

function timeEncoder(encode: () => string): { msPer1000: number } {
  const start = performance.now();
  for (let index = 0; index < 1000; index += 1) encode();
  return { msPer1000: performance.now() - start };
}

function formatLegacyExecutionCapsule(value: any): string {
  const files = Array.from(new Set([...(value.read_first || []), ...(value.edit_scope || [])]));
  const fileIndex = new Map(files.map((file, index) => [file, index + 1]));
  const encodeFiles = (input: string[] = []) => input.map(file => fileIndex.get(file) || file).join(',');
  const ops = (value.ops || [])
    .map((item: any) => `${fileIndex.get(item.file) || item.file}:${shortLong(item.op, 96)}`)
    .join(';');
  const list = (prefix: string, input: string[] = [], max = 64) =>
    input.length ? `${prefix}|${input.slice(0, 3).map(item => shortLong(item, max)).join(';')}` : '';
  return [
    `${ops ? 'K4' : 'K3'}|${short(value.task_type).slice(0, 1)}|${shortLong(value.target, 44)}`,
    files.length ? `F|${files.map((file, index) => `${index + 1}:${file}`).join(';')}` : '',
    encodeFiles(value.read_first).length ? `R|${encodeFiles(value.read_first)}` : '',
    encodeFiles(value.edit_scope).length ? `E|${encodeFiles(value.edit_scope)}` : '',
    ops ? `O|${ops}` : '',
    ops ? '' : list('D', value.do, 68),
    list('T', value.test, 58),
    list('X', value.no, 58),
    list('P', value.preserve, 64),
    value.validate?.length ? `V|${value.validate.slice(0, 1).join(';')}` : '',
    value.token_policy ? `B|f${value.token_policy.source_files || '?'},w${value.token_policy.final_response_words || '?'}` : '',
    'S|val-stop',
  ].filter(Boolean).join('\n');
}

function shortLong(value: string, max: number): string {
  const text = String(value || '')
    .replace(/\brepository\b/gi, 'repo')
    .replace(/\bvalidation\b/gi, 'val')
    .replace(/\bservice\b/gi, 'svc')
    .replace(/\bcontroller\b/gi, 'ctrl')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function percentReduction(baseline: number, current: number): number {
  return Math.round(((baseline - current) / Math.max(1, baseline)) * 1000) / 10;
}

function short(value: string): string {
  return String(value || '')
    .replace(/\brepository\b/gi, 'repo')
    .replace(/\bservice\b/gi, 'svc')
    .replace(/\bvalidation\b/gi, 'val')
    .replace(/\bproject\b/gi, 'proj')
    .replace(/\bsummary\b/gi, 'sum')
    .replace(/\s+/g, '-')
    .slice(0, 60);
}

if (require.main === module) {
  const report = benchmarkExecutionCapsuleFormats();
  const output = process.argv.includes('--output')
    ? process.argv[process.argv.indexOf('--output') + 1]
    : '';
  if (output) {
    fs.ensureDirSync(path.dirname(output));
    fs.writeJsonSync(output, report, { spaces: 2 });
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
