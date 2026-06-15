import * as fs from 'fs-extra';
import * as path from 'path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { getAgentBootstrap } from './agent-bootstrap';
import { getAgentDoctor } from './agent-doctor';
import type { AgentTask } from './agent-adoption';

export interface AgentDefaultConfig {
  path: string;
  generated_at: string;
  status: string;
  default_use: boolean;
  required_rule: string;
  mcp_server: {
    name: string;
    command: string;
    cwd: string;
  };
  first_calls: Array<{
    order: number;
    tool: string;
    args: Record<string, unknown>;
    purpose: string;
    path_source?: string;
  }>;
  prompts: {
    agent_instruction: string;
    repository_snippet: string;
    agent_skill: string;
  };
  doctor: Awaited<ReturnType<typeof getAgentDoctor>>;
  bootstrap: Awaited<ReturnType<typeof getAgentBootstrap>>;
  install?: {
    directory: string;
    json_file: string;
    markdown_file: string;
    skill_directory: string;
    skill_file: string;
  };
}

export async function getAgentDefaultConfig(
  cas: CASOutput,
  projectPath: string,
  task: AgentTask = {},
  options: { assumeFresh?: boolean } = {}
): Promise<AgentDefaultConfig> {
  const doctor = await getAgentDoctor(cas, projectPath, options);
  const bootstrap = await getAgentBootstrap(cas, projectPath, task);
  const mcpServerDir = findMcpServerDir();
  const selectedPathSource = 'Use resolve_agent_analysis.selected_path when present; otherwise use this original path.';
  const firstCalls = [
    {
      order: 1,
      tool: 'resolve_agent_analysis',
      args: { path: projectPath, task },
      purpose: 'Select the most specific default-use analysis when the repository has analyzed subprojects.',
    },
    {
      order: 2,
      tool: 'get_agent_doctor',
      args: { path: projectPath },
      purpose: 'Verify the CAS is fresh enough and complete enough for default agent use.',
      path_source: selectedPathSource,
    },
    {
      order: 3,
      tool: 'get_agent_start_context',
      args: { path: projectPath, task },
      purpose: 'Load system orientation, graph anchors, readiness, and first MCP calls.',
      path_source: selectedPathSource,
    },
    {
      order: 4,
      tool: 'get_agent_work_packet',
      args: { path: projectPath, task: { ...task, response_profile: 'capsule-only' } },
      purpose: 'Get the smallest task packet: read the K15 context capsule, then execute the K5 capsule before broad file exploration.',
      path_source: selectedPathSource,
    },
    {
      order: 5,
      tool: 'open_agent_workbench',
      args: { path: projectPath, task },
      purpose: 'Use only when the K15/K5 first-turn packet leaves a concrete gap or the task needs the full evidence policy.',
      path_source: selectedPathSource,
    },
  ];

  return {
    path: projectPath,
    generated_at: new Date().toISOString(),
    status: doctor.status,
    default_use: doctor.default_use,
    required_rule: 'Before broad file reads, call Klauro MCP for doctor, start context, and get_agent_work_packet with response_profile="capsule-only". Read the K15 context capsule for orientation, execute the K5 capsule for the edit, then read source only after Klauro narrows the graph or reports a gap. Use response_profile="first-turn" only when the capsule-only packet leaves a concrete gap. Before multi-file plans call preflight_agent_change. After edits, call validate_agent_change before finalizing.',
    mcp_server: {
      name: 'klauro',
      command: `npm --prefix ${mcpServerDir} run start`,
      cwd: mcpServerDir,
    },
    first_calls: firstCalls,
    prompts: {
      agent_instruction: bootstrap.prompt,
      repository_snippet: repositorySnippet(projectPath),
      agent_skill: formatKlauroAgentSkill(projectPath),
    },
    doctor,
    bootstrap,
  };
}

export async function writeAgentDefaultConfig(
  cas: CASOutput,
  projectPath: string,
  task: AgentTask = {},
  options: { assumeFresh?: boolean } = {}
): Promise<AgentDefaultConfig> {
  const config = await getAgentDefaultConfig(cas, projectPath, task, options);
  const directory = path.join(projectPath, '.klauro');
  const jsonFile = path.join(directory, 'agent-defaults.json');
  const markdownFile = path.join(directory, 'agent-defaults.md');
  const skillDirectory = path.join(directory, 'skills', 'klauro');
  const skillFile = path.join(skillDirectory, 'SKILL.md');

  await fs.ensureDir(directory);
  await fs.ensureDir(skillDirectory);
  const withInstall = {
    ...config,
    install: {
      directory,
      json_file: jsonFile,
      markdown_file: markdownFile,
      skill_directory: skillDirectory,
      skill_file: skillFile,
    },
  };
  await fs.writeJson(jsonFile, withInstall, { spaces: 2 });
  await fs.writeFile(markdownFile, formatAgentDefaultMarkdown(withInstall), 'utf8');
  await fs.writeFile(skillFile, withInstall.prompts.agent_skill, 'utf8');
  return withInstall;
}

export function formatAgentDefaultMarkdown(config: AgentDefaultConfig): string {
  const calls = config.first_calls
    .map(call => `${call.order}. ${call.tool} ${JSON.stringify(call.args)}\n   ${call.purpose}${call.path_source ? `\n   Path source: ${call.path_source}` : ''}`)
    .join('\n');
  return [
    '# Klauro Agent Defaults',
    '',
    `Generated: ${config.generated_at}`,
    `Status: ${config.status}`,
    `Default use: ${config.default_use ? 'yes' : 'no'}`,
    '',
    '## Required Rule',
    '',
    config.required_rule,
    '',
    'Use the `selected_path` returned by `resolve_agent_analysis` for every follow-up call when it differs from the original path.',
    '',
    '## MCP Server',
    '',
    `Name: ${config.mcp_server.name}`,
    `Command: ${config.mcp_server.command}`,
    `Working directory: ${config.mcp_server.cwd}`,
    '',
    '## First Calls',
    '',
    calls,
    '',
    '## Repository Snippet',
    '',
    '```md',
    config.prompts.repository_snippet,
    '```',
    '',
    '## Agent Skill',
    '',
    config.install?.skill_file
      ? `A portable Klauro agent skill was written to ${config.install.skill_file}. Install or copy that skill into Claude, Codex, or another agent skill directory when the agent supports skills.`
      : 'Run install_agent_default_config to write the portable Klauro agent skill.',
    '',
  ].join('\n');
}

export function formatKlauroAgentSkill(projectPath: string): string {
  return [
    '---',
    'name: klauro',
    'version: 1.0.0',
    'description: Use Klauro CAS and MCP work packets before broad source exploration; decode K15, K5, and G1 prompt capsules for token-minimal agent work.',
    'triggers:',
    '  - klauro',
    '  - use klauro',
    '  - codebase intelligence',
    '  - work packet',
    '  - agent context',
    '---',
    '',
    '# Klauro Agent Skill',
    '',
    'Use this skill when working in a repository with a Klauro analysis, or when the user asks to analyze, orient, modify, debug, review, trace, or build with Klauro context.',
    '',
    '## Default Loop',
    '',
    `1. Call \`resolve_agent_analysis\` with path \`${projectPath}\` and the current task. If it returns \`selected_path\`, use that selected path for every follow-up call.`,
    '2. Call `get_agent_start_context` before broad source reads.',
    '3. Call `get_agent_tool_plan` for the task type.',
    '4. For concrete work, call `get_agent_work_packet` with `task.response_profile="capsule-only"`.',
    '5. Read the `K15` context capsule first, then execute the `K5` execution capsule before opening other source files.',
    '6. Use `first-turn` or `open_agent_workbench` only when capsule-only leaves a concrete gap.',
    '7. Before multi-file plans, call `preflight_agent_change`.',
    '8. After edits, call `validate_agent_change`; use invariant and idiom validation when behavior or conventions changed.',
    '',
    '## K15 Context Capsule',
    '',
    '```text',
    'K15mts target',
    'A0 src/auth 1 tests/auth',
    'E0 auth.service 1 auth.service.test',
    'O0 oidc.client',
    'C0 session.repository',
    '@AuthService svc 1 18',
    'IDIctor tenantSess',
    'USessionRepoReuse',
    'RhiAuthSess invTenantId',
    'Vtest 2 typecheck',
    '!F idioms expandIfBlocked',
    '```',
    '',
    '- The optional extension in the header, such as `K15mts`, restores `.ts` on suffixes without an explicit known extension.',
    '- `A` defines path aliases.',
    '- `E`, `O`, and `C` define indexed files in order: read-then-edit, open/read-first, then candidate/read-only.',
    '- `1`, `2`, etc. refer to indexed files from those role lines.',
    '- `@` is the selected CAS target.',
    '- `I`, `U`, and `R` are local idioms, reuse guidance, risks, and invariants.',
    '- `V` is focused validation. Expand file refs before running commands.',
    '- `!` is the expansion rule.',
    '- Read `E` and `O` files first; edit only `E` files unless source evidence proves the target moved.',
    '- Expand to `first-turn` or full JSON only when K15/K5 is contradictory, misses a concrete required owner, or validation identifies an uncovered path.',
    '',
    '## K5 Execution Capsule',
    '',
    '```text',
    'K5|m|target',
    'F|1*:src/owner.ts;2:src/dependency.ts;3*:tests/owner.test.ts',
    'O|1:file-scoped operation;3:test operation',
    'Q|required proof',
    'N|forbidden shortcut',
    'P|preserve boundary or idiom',
    'V|validation command',
    'B|f2,w40',
    'S|val-stop',
    '```',
    '',
    'Read all `F` files first, edit only `*` or `!` files, follow `O/A/Q/N/P/V/S`, and do not expand beyond the file set unless the capsule is contradictory, validation identifies a concrete missing owner, or source proves the target moved.',
    '',
    '## G1 Greenfield Capsule',
    '',
    '```text',
    'G1|0|Build one coherent product slice',
    'B|requested behaviors',
    'P|architecture patterns to use',
    'C|concepts to reuse',
    'E|behavior@owner files',
    'O|owner files',
    'R|read-first files',
    'N|next files to create/update',
    'D|do-not-rebuild rules',
    'V|validation checks',
    '!|stop rule',
    '```',
    '',
    'For empty folders or growing new projects, call `get_greenfield_build_packet` before creating or extending files. Build exactly the G1 product slice, preserve the anti-duplication rules, run validation, then stop for Klauro re-analysis.',
    '',
    '## Fallback',
    '',
    'If Klauro reports no analysis, stale analysis, a failed doctor check, missing evidence, or a tool error, report that clearly and then fall back to direct source reading for the current task.',
    '',
  ].join('\n');
}

function repositorySnippet(projectPath: string): string {
  return [
    '## Klauro Agent Rule',
    '',
    'Before broad file reads, use the Klauro MCP server for this repository.',
    '',
    `1. Call resolve_agent_analysis with path ${JSON.stringify(projectPath)} and the current task; use the selected path when it differs.`,
    `2. Call get_agent_doctor with the selected path.`,
    `3. Call get_agent_work_packet with the selected path, current task, and response_profile "capsule-only".`,
    '4. Read the K15 context capsule first, then execute the K5 capsule before broad source exploration: restore header extensions, read E/O files first, edit only E files unless source proves the target moved, preserve I/U/R guidance, run V checks, and expand only if the capsules are contradictory.',
    '5. Retry get_agent_work_packet with response_profile "first-turn" or call open_agent_workbench only when the capsule-only packet leaves a concrete gap or the task needs the full evidence policy.',
    `6. For multi-file plans or refactors, call preflight_agent_change before presenting the final plan or editing.`,
    '7. Read source files after Klauro identifies target files or after MCP reports a concrete gap.',
    '8. After edits, call validate_agent_change with the same selected path before finalizing.',
    '9. Treat stale analysis, CAS errors, failed doctor checks, and validate_agent_change failures as blocking context problems to report before coding.',
  ].join('\n');
}

function findMcpServerDir(): string {
  const candidates = [
    path.resolve(__dirname, '..'),
    path.join(process.cwd(), 'mcp-server'),
    process.cwd(),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      try {
        const pkg = fs.readJsonSync(path.join(candidate, 'package.json'));
        if (pkg.name === '@klauro/mcp-server') return candidate;
      } catch {
      }
    }
  }
  return process.cwd();
}
