/**
 * LLM judge — scores an arm's ACTUAL answer against the expected outcome, so the
 * gauntlet's quality axis is measured (judged on the result) rather than inferred
 * from execution signals. Opt-in: enabled when a judge command is configured
 * (env KLAURO_JUDGE_CMD) or KLAURO_JUDGE is truthy and an agent CLI is on PATH.
 * When unavailable it returns null and the caller falls back to the deterministic
 * execution-quality proxy — never a fabricated score.
 *
 * The judge is deliberately model-agnostic: it shells out to a command that reads
 * a judging prompt and prints a single integer 0..100. `claude -p` and
 * `codex exec` both satisfy this, and any other scorer can be wired via
 * KLAURO_JUDGE_CMD with a {prompt_file} placeholder.
 */

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface JudgeInput {
  task: string;
  expected: string;
  armLabel: string;
  /** The arm's produced answer/result (result file content + summary). */
  resultText: string;
  /** Optional extra evidence (diff stat, validation outcome). */
  evidence?: string;
}

export interface JudgeOutcome {
  score: number;      // 0..100
  judge: string;      // which judge produced it
}

/** Resolve the judge command template, or null if judging is not enabled. */
export function resolveJudgeCommand(): { command: string; label: string } | null {
  const explicit = process.env.KLAURO_JUDGE_CMD;
  if (explicit) return { command: explicit, label: 'configured-judge' };
  // Auto-judge only when explicitly opted in, to avoid surprise CLI/LLM cost.
  if (!truthy(process.env.KLAURO_JUDGE)) return null;
  const model = process.env.KLAURO_JUDGE_MODEL;
  if (which('claude')) {
    return { command: `claude -p${model ? ` --model ${model}` : ''} "$(cat {prompt_file})"`, label: 'claude-judge' };
  }
  if (which('codex')) {
    return { command: `codex exec --skip-git-repo-check "$(cat {prompt_file})"`, label: 'codex-judge' };
  }
  return null;
}

function buildJudgePrompt(input: JudgeInput): string {
  return [
    'You are an impartial grader. Score how well a RESULT satisfies the EXPECTED OUTCOME for a software task.',
    'Grade only the result\'s correctness, completeness, and specificity against the expected outcome.',
    '',
    `TASK: ${input.task}`,
    `EXPECTED OUTCOME: ${input.expected}`,
    input.evidence ? `EVIDENCE: ${input.evidence}` : '',
    '',
    `RESULT (from "${input.armLabel}"):`,
    truncate(input.resultText, 6000),
    '',
    'Reply with ONLY a single integer from 0 to 100 (no words, no punctuation, no explanation).',
  ].filter(Boolean).join('\n');
}

/** Judge one arm's answer. Returns null if judging is unavailable or fails. */
export async function judgeQuality(
  input: JudgeInput,
  opts: { command?: string; label?: string; timeoutMs?: number } = {}
): Promise<JudgeOutcome | null> {
  const resolved = opts.command ? { command: opts.command, label: opts.label || 'configured-judge' } : resolveJudgeCommand();
  if (!resolved) return null;
  if (!input.resultText || !input.resultText.trim()) return null;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-judge-'));
  const promptFile = path.join(dir, 'judge-prompt.txt');
  try {
    await fs.writeFile(promptFile, buildJudgePrompt(input), 'utf8');
    const command = resolved.command.replace(/\{prompt_file\}/g, promptFile);
    const { stdout } = await execFileAsync('bash', ['-lc', command], {
      timeout: opts.timeoutMs || 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const score = parseScore(stdout);
    if (score == null) return null;
    return { score, judge: resolved.label };
  } catch {
    return null;
  } finally {
    await fs.remove(dir).catch(() => undefined);
  }
}

/** Extract the first integer 0..100 from judge output. */
export function parseScore(text: string): number | null {
  const matches = String(text).match(/\b(100|[0-9]{1,2})\b/g);
  if (!matches) return null;
  // Prefer the LAST standalone number (models often restate then answer).
  for (let i = matches.length - 1; i >= 0; i--) {
    const n = Number(matches[i]);
    if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
  }
  return null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}

function truthy(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function which(bin: string): boolean {
  // PATH probe without spawning: check common dirs + PATH entries.
  const paths = (process.env.PATH || '').split(path.delimiter);
  const extra = [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of [...paths, ...extra]) {
    try { if (dir && fs.existsSync(path.join(dir, bin))) return true; } catch { /* ignore */ }
  }
  return false;
}
