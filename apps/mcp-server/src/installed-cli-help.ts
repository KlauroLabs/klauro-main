import { KLAURO_INSTALL_ONELINER } from './self-update';

interface CommandHelp {
  names: string[];
  lines: string[];
}

const COMMAND_HELP: CommandHelp[] = [
  {
    names: ['init'],
    lines: [
      '  init [path]                 Configure a project for hosted Klauro analysis',
    ],
  },
  {
    names: ['install'],
    lines: [
      '  install                     Register the lightweight MCP with Claude and Codex',
    ],
  },
  {
    names: ['uninstall'],
    lines: [
      '  uninstall [--no-deregister] Remove Klauro MCP registrations; keep account and analysis data',
    ],
  },
  {
    names: ['analyze', 'remote-analyze'],
    lines: [
      '  analyze [path] [--server-url url] [--analysis-id id] [--analysis-focus agent-fast|ui-overview|deep-context|full] [--json] [--quiet] [--force] [--yes] [--wait]',
      '                               Upload a committed source snapshot for hosted analysis',
      '                               --force bypasses BOTH the server\'s reuse-of-unchanged-snapshot shortcut AND the',
      '                               AI response cache, so structure and AI-generated names/descriptions are freshly',
      '                               produced instead of served from a prior run.',
      '                               --yes confirms uploading a root that looks like it contains several unrelated',
      '                               projects instead of one (no Git repo/manifest of its own, multiple nested repos',
      '                               beneath it) — without it this refuses (scripted) or prompts (interactive).',
      '                               --wait blocks until the hosted analysis is complete and returns its CAS.',
      '                               Alias: remote-analyze',
    ],
  },
  {
    names: ['remote-sync', 'sync'],
    lines: [
      '  remote-sync [path] [--yes] [--wait]',
      '                               Upload in-flight changes; --wait returns the completed incremental CAS',
      '                               Alias: sync',
    ],
  },
  {
    names: ['upload-manifest', 'index'],
    lines: [
      '  upload-manifest [path]      Preview source files selected for upload',
    ],
  },
  {
    names: ['status'],
    lines: [
      '  status [path] [--server-url URL]',
      '                               One-glance report: account, release, project connection, analysis, MCP',
    ],
  },
  {
    names: ['doctor'],
    lines: [
      '  doctor [path] [--server-url URL]',
      '                               Diagnose node version, auth/token age, server reachability, MCP registration',
    ],
  },
  {
    names: ['support-bundle'],
    lines: [
      '  support-bundle [path] [--output FILE]',
      '                               Package redacted environment + run-log diagnostics to send to support',
    ],
  },
  {
    names: ['update'],
    lines: [
      '  update [--check] [--force]  Install the latest hosted klauro release over this one',
    ],
  },
  {
    names: ['login'],
    lines: [
      '  login [--email EMAIL] [--password-stdin | --register]',
      '                               Prompts for email/password (no echo) if not given; --password-stdin for scripts',
    ],
  },
  {
    names: ['auth-status', 'whoami', 'logout', 'version'],
    lines: [
      '  auth-status | whoami | logout | version',
    ],
  },
  {
    names: ['accounts'],
    lines: [
      '  accounts [--server-url URL] [--use EMAIL]',
      '                               List every account signed into this server on this machine, or switch the active one (no password needed if already logged in as EMAIL)',
    ],
  },
  {
    names: ['change-password'],
    lines: [
      '  change-password [--current-password-stdin] [--new-password-stdin]',
      '                               Requires an existing session + current password; invalidates every other session',
    ],
  },
  {
    names: ['reset-password'],
    lines: [
      '  reset-password --token TOKEN [--token-stdin] [--new-password-stdin]',
      '                               Redeems a single-use token an operator minted with admin-mint-reset-token',
    ],
  },
  {
    names: ['admin-mint-reset-token'],
    lines: [
      '  admin-mint-reset-token --email EMAIL [--data-dir PATH] [--minted-by LABEL]',
      '                               OPERATOR-ONLY: mints a 30-minute single-use reset token directly against the account store',
    ],
  },
];

const USAGE_HEADER = ['Usage: klauro <command> [path] [options]', ''];

const USAGE_FOOTER = [
  '',
  `If \`klauro update\` cannot run, reinstall from scratch: ${KLAURO_INSTALL_ONELINER}`, '',
  'Analysis, CAS construction at every level, graphs, proposals, embeddings, and AI execute only on Klauro infrastructure.',
  '',
  'Every subcommand accepts --help/-h to print its own usage instead of running.',
];

export function usageText(command?: string): string {
  const entries = command ? COMMAND_HELP.filter(entry => entry.names.includes(command)) : [];
  if (entries.length === 0) return [...USAGE_HEADER, ...COMMAND_HELP.flatMap(entry => entry.lines), ...USAGE_FOOTER].join('\n') + '\n';
  return [`Usage: klauro ${command} ...`, '', ...entries.flatMap(entry => entry.lines), ''].join('\n') + '\n';
}
