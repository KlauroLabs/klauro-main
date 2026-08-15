














import { isDirectCliInvocation } from '../cli-invocation';
import { runGauntlet, gauntletHomeDir } from './runner';
import { startUiServer } from './ui-server';
import { SCENARIOS } from './report-schema';
import { defaultAgentCommands } from './live-driver';

interface Args {
  live: boolean;
  maxRepos?: number;
  scenarioIds?: string[];
  ui: boolean;
  port: number;
  help: boolean;
  withKlauroCmd?: string;
  withoutKlauroCmd?: string;
  timeoutMs?: number;
  agent?: 'claude' | 'codex';
  judge?: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { live: false, ui: false, port: 7878, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--ui') args.ui = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--max-repos') args.maxRepos = Number(argv[++i]);
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--scenarios') args.scenarioIds = String(argv[++i]).split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--with-klauro-cmd') args.withKlauroCmd = argv[++i];
    else if (a === '--without-klauro-cmd') args.withoutKlauroCmd = argv[++i];
    else if (a === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (a === '--agent') args.agent = argv[++i] as any;
    else if (a === '--judge') args.judge = true;
  }
  return args;
}

function printHelp(): void {
  console.log('Unified Gauntlet — scenarios x arms x metrics, with a win-validator.\n');
  console.log('Scenarios:');
  for (const s of SCENARIOS) console.log(`  ${s.id.padEnd(22)} ${s.label}  [${s.group}/${s.execution}]`);
  console.log('\nFlags: --live  --max-repos <n>  --scenarios a,b  --ui  --port <n>');
  console.log('Live:  --live --agent claude|codex   (ready launchers; Klauro arm keeps MCP, others --strict-mcp-config)');
  console.log('       --judge                        (LLM-judge quality on the real answer; needs claude/codex on PATH)');
  console.log('       --with-klauro-cmd / --without-klauro-cmd "<cmd>"  --timeout-ms <n>   (custom launchers)');
  console.log('       env: KLAURO_LIVE_WITH_CMD / KLAURO_LIVE_WITHOUT_CMD / KLAURO_JUDGE=1 / KLAURO_JUDGE_CMD / KLAURO_JUDGE_MODEL');
  console.log('       templates use {prompt_file} {workspace} {metrics_file} {result_file} {task_id} {arm}.');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }


  if (args.judge) process.env.KLAURO_JUDGE = '1';
  const agentDefaults = args.agent ? defaultAgentCommands(args.agent) : undefined;

  console.log(`[gauntlet] running ${args.scenarioIds ? args.scenarioIds.join(',') : 'all scenarios'} (${args.live ? 'live+projected' : 'projected'}${args.judge ? ', judged' : ''}${args.agent ? `, agent=${args.agent}` : ''})`);
  const report = await runGauntlet({
    live: args.live,
    maxRepos: args.maxRepos,
    scenarioIds: args.scenarioIds,
    liveCommands: {
      withKlauro: args.withKlauroCmd || agentDefaults?.withKlauro,
      withoutKlauro: args.withoutKlauroCmd || agentDefaults?.withoutKlauro,
      timeoutMs: args.timeoutMs,
    },
    onProgress: r => {
      const p = r.progress;
      process.stdout.write(`\r[gauntlet] ${p.completed}/${p.total_scenarios} done  won=${r.summary.scenarios_won} lost=${r.summary.scenarios_lost}   `);
    },
  });
  process.stdout.write('\n');

  const s = report.summary;
  console.log(`[gauntlet] DONE  klauro_wins_all=${s.klauro_wins_all}  won=${s.scenarios_won}  lost=${s.scenarios_lost}`);
  if (s.losses.length) {
    console.log('[gauntlet] LOSSES (Klauro bugs to fix):');
    for (const l of s.losses) console.log(`  - ${l.scenario_id}: ${l.summary}  [${l.losing_metrics.join(', ')}]`);
  }
  console.log(`[gauntlet] report: ${gauntletHomeDir()}/latest.json`);

  if (args.ui) {
    await startUiServer({ port: args.port });
  }
}

if (isDirectCliInvocation('index')) {
  main().catch(err => { console.error(err); process.exit(1); });
}
