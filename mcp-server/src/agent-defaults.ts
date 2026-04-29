import * as fs from 'fs-extra';
import * as path from 'path';
import type { CASOutput } from '../../backend/src/types/cas.types';
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
  }>;
  prompts: {
    agent_instruction: string;
    repository_snippet: string;
  };
  doctor: Awaited<ReturnType<typeof getAgentDoctor>>;
  bootstrap: ReturnType<typeof getAgentBootstrap>;
  install?: {
    directory: string;
    json_file: string;
    markdown_file: string;
  };
}

export async function getAgentDefaultConfig(
  cas: CASOutput,
  projectPath: string,
  task: AgentTask = {},
  options: { assumeFresh?: boolean } = {}
): Promise<AgentDefaultConfig> {
  const doctor = await getAgentDoctor(cas, projectPath, options);
  const bootstrap = getAgentBootstrap(cas, projectPath, task);
  const mcpServerDir = findMcpServerDir();
  const firstCalls = [
    {
      order: 1,
      tool: 'get_agent_doctor',
      args: { path: projectPath },
      purpose: 'Verify the CAS is fresh enough and complete enough for default agent use.',
    },
    {
      order: 2,
      tool: 'get_agent_start_context',
      args: { path: projectPath, task },
      purpose: 'Load system orientation, graph anchors, readiness, and first MCP calls.',
    },
    {
      order: 3,
      tool: 'get_agent_work_packet',
      args: { path: projectPath, task },
      purpose: 'Resolve the target, change risk, tests, follow-up tools, and first source files.',
    },
  ];

  return {
    path: projectPath,
    generated_at: new Date().toISOString(),
    status: doctor.status,
    default_use: doctor.default_use,
    required_rule: 'Before broad file reads, call Unravl MCP for doctor, start context, and work packet. Read source after Unravl narrows the graph or reports a gap.',
    mcp_server: {
      name: 'unravl',
      command: `npm --prefix ${mcpServerDir} run start`,
      cwd: mcpServerDir,
    },
    first_calls: firstCalls,
    prompts: {
      agent_instruction: bootstrap.prompt,
      repository_snippet: repositorySnippet(projectPath),
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
  const directory = path.join(projectPath, '.unravl');
  const jsonFile = path.join(directory, 'agent-defaults.json');
  const markdownFile = path.join(directory, 'agent-defaults.md');

  await fs.ensureDir(directory);
  const withInstall = {
    ...config,
    install: {
      directory,
      json_file: jsonFile,
      markdown_file: markdownFile,
    },
  };
  await fs.writeJson(jsonFile, withInstall, { spaces: 2 });
  await fs.writeFile(markdownFile, formatAgentDefaultMarkdown(withInstall), 'utf8');
  return withInstall;
}

export function formatAgentDefaultMarkdown(config: AgentDefaultConfig): string {
  const calls = config.first_calls.map(call => `${call.order}. ${call.tool} ${JSON.stringify(call.args)}\n   ${call.purpose}`).join('\n');
  return [
    '# Unravl Agent Defaults',
    '',
    `Generated: ${config.generated_at}`,
    `Status: ${config.status}`,
    `Default use: ${config.default_use ? 'yes' : 'no'}`,
    '',
    '## Required Rule',
    '',
    config.required_rule,
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
  ].join('\n');
}

function repositorySnippet(projectPath: string): string {
  return [
    '## Unravl Agent Rule',
    '',
    'Before broad file reads, use the Unravl MCP server for this repository.',
    '',
    `1. Call get_agent_doctor with path ${JSON.stringify(projectPath)}.`,
    `2. Call get_agent_start_context with path ${JSON.stringify(projectPath)} and the current task.`,
    `3. Call get_agent_work_packet with path ${JSON.stringify(projectPath)} and the current task.`,
    '4. Read source files after the work packet identifies the target files or after MCP reports a concrete gap.',
    '5. Treat stale analysis, CAS errors, and failed doctor checks as blocking context problems to report before coding.',
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
        if (pkg.name === '@unravl/mcp-server') return candidate;
      } catch {
      }
    }
  }
  return process.cwd();
}
