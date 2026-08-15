import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CliAnalyzer } from './cli-analyzer';

function makeTempProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-analyzer-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function names(entryPoints: { name: string }[]): string[] {
  return entryPoints.map(e => e.name).sort();
}

test('CliAnalyzer.canAnalyze is false for a project with no CLI framework signal', async () => {
  const dir = makeTempProject({ 'readme.py': '# nothing here\n' });
  try {
    const analyzer = new CliAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CliAnalyzer extracts Click commands and groups', async () => {
  const src = [
    'import click',
    '',
    '@click.group()',
    'def cli():',
    '    pass',
    '',
    "@cli.command(name='sync-now')",
    'def sync():',
    '    """Sync data."""',
    '',
    '@cli.command()',
    'def status():',
    '    pass',
    '',
  ].join('\n');
  const dir = makeTempProject({ 'app.py': src });
  try {
    const analyzer = new CliAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true);
    const cas = await analyzer.analyze({ projectPath: dir });
    const cliEntries = cas.entry_points.filter(e => e.type === 'cli');
    assert.ok(cliEntries.some(e => e.name === 'sync-now'));
    assert.ok(cliEntries.some(e => e.name === 'status'));
    assert.ok(cliEntries.some(e => /command group/.test(e.name)));
    const syncEntry = cliEntries.find(e => e.name === 'sync-now')!;
    assert.equal(syncEntry.metadata?.framework, 'click');
    assert.equal(syncEntry.metadata?.handler, 'sync');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CliAnalyzer extracts argparse subparsers with func= handlers', async () => {
  const src = [
    'import argparse',
    '',
    'def cmd_build(args):',
    '    return 0',
    '',
    'def cmd_serve(args):',
    '    return 0',
    '',
    'parser = argparse.ArgumentParser(prog="kadra")',
    'subparsers = parser.add_subparsers(dest="command", required=True)',
    '',
    'build_p = subparsers.add_parser("build", help="execute a plan")',
    'build_p.set_defaults(func=cmd_build)',
    '',
    'serve_p = subparsers.add_parser("serve", help="start server")',
    'serve_p.set_defaults(func=cmd_serve)',
    '',
  ].join('\n');
  const dir = makeTempProject({ 'main.py': src });
  try {
    const analyzer = new CliAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });
    const cliNames = names(cas.entry_points);
    assert.deepEqual(cliNames, ['build', 'serve']);
    const buildEntry = cas.entry_points.find(e => e.name === 'build')!;
    assert.equal(buildEntry.metadata?.framework, 'argparse');
    assert.equal(buildEntry.metadata?.handler, 'cmd_build');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CliAnalyzer extracts Commander subcommands with actions', async () => {
  const src = [
    "const { program } = require('commander');",
    '',
    "program",
    "  .command('deploy <target>')",
    "  .description('deploy to target')",
    '  .action(function deployHandler(target) {',
    '    console.log(target);',
    '  });',
    '',
    "program",
    "  .command('status')",
    '  .action(async () => {});',
    '',
    'program.parse();',
    '',
  ].join('\n');
  const dir = makeTempProject({ 'cli.js': src });
  try {
    const analyzer = new CliAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });
    const cliNames = names(cas.entry_points);
    assert.deepEqual(cliNames, ['deploy', 'status']);
    const deployEntry = cas.entry_points.find(e => e.name === 'deploy')!;
    const statusEntry = cas.entry_points.find(e => e.name === 'status')!;
    assert.equal(deployEntry.metadata?.framework, 'commander');
    assert.equal(deployEntry.handler?.method_name, 'deployHandler');
    assert.equal(statusEntry.handler?.node_id, statusEntry.source_node);
    assert.notEqual(statusEntry.handler?.method_name, 'status');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CliAnalyzer extracts cobra command Use + Run handler', async () => {
  const src = [
    'package cmd',
    '',
    'import "github.com/spf13/cobra"',
    '',
    'var rootCmd = &cobra.Command{',
    '  Use:   "zerac",',
    '  Short: "Zerac CLI",',
    '}',
    '',
    'var scanCmd = &cobra.Command{',
    '  Use:   "scan [target]",',
    '  Short: "run a scan",',
    '  RunE:  runScan,',
    '}',
    '',
    'func init() {',
    '  rootCmd.AddCommand(scanCmd)',
    '}',
    '',
  ].join('\n');
  const dir = makeTempProject({ 'cmd/root.go': src });
  try {
    const analyzer = new CliAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });
    const cliNames = names(cas.entry_points);
    assert.ok(cliNames.includes('scan'));
    const scanEntry = cas.entry_points.find(e => e.metadata?.command === 'scan')!;
    assert.equal(scanEntry.metadata?.framework, 'cobra');
    assert.equal(scanEntry.metadata?.handler, 'runScan');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CliAnalyzer extracts clap derive(Subcommand) enum variants', async () => {
  const src = [
    'use clap::{Parser, Subcommand};',
    '',
    '#[derive(Parser)]',
    '#[command(name = "zerac-scan")]',
    'struct Cli {',
    '    #[command(subcommand)]',
    '    command: Commands,',
    '}',
    '',
    '#[derive(Subcommand)]',
    'enum Commands {',
    '    Discovery,',
    '    Scan { target: String },',
    '    Report(ReportArgs),',
    '}',
    '',
  ].join('\n');
  const dir = makeTempProject({ 'src/cli.rs': src });
  try {
    const analyzer = new CliAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });
    const cliNames = names(cas.entry_points);
    assert.ok(cliNames.includes('discovery'));
    assert.ok(cliNames.includes('scan'));
    assert.ok(cliNames.includes('report'));
    const discoveryEntry = cas.entry_points.find(e => e.name === 'discovery')!;
    assert.equal(discoveryEntry.metadata?.framework, 'clap');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CliAnalyzer extracts a flat clap Parser struct with no subcommands', async () => {
  const src = [
    'use clap::Parser;',
    '',
    '#[derive(Parser, Debug, Clone)]',
    '#[command(name = "zerac-scan", about = "Zerac CLI Network Scanner")]',
    'pub struct Cli {',
    '    #[arg(long)]',
    '    pub discovery: bool,',
    '}',
    '',
  ].join('\n');
  const dir = makeTempProject({ 'src/cli.rs': src });
  try {
    const analyzer = new CliAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });
    const cliEntries = cas.entry_points;
    assert.equal(cliEntries.length, 1);
    assert.equal(cliEntries[0].name, 'zerac-scan');
    assert.equal(cliEntries[0].metadata?.framework, 'clap');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CliAnalyzer extracts Thor commands via desc + method', async () => {
  const src = [
    "require 'thor'",
    '',
    'class MyCli < Thor',
    "  desc 'build', 'build the project'",
    '  def build',
    '  end',
    '',
    "  desc 'deploy TARGET', 'deploy to target'",
    '  def deploy(target)',
    '  end',
    'end',
    '',
  ].join('\n');
  const dir = makeTempProject({ 'cli.rb': src });
  try {
    const analyzer = new CliAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });
    const cliNames = names(cas.entry_points);
    assert.deepEqual(cliNames, ['build', 'deploy']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CliAnalyzer falls back to a generic main() entry point when no framework is detected', async () => {
  const src = [
    'def do_work():',
    '    pass',
    '',
    "if __name__ == '__main__':",
    '    do_work()',
    '',
  ].join('\n');
  const dir = makeTempProject({ 'script.py': src });
  try {
    const analyzer = new CliAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true);
    const cas = await analyzer.analyze({ projectPath: dir });
    assert.equal(cas.entry_points.length, 1);
    assert.equal(cas.entry_points[0].metadata?.framework, 'generic');
    assert.equal(cas.entry_points[0].handler?.method_name, 'do_work');
    assert.ok(cas.nodes.some(node => node.id === cas.entry_points[0].source_node));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CliAnalyzer does not invent a main handler for an object method inside a Python main guard', async () => {
  const dir = makeTempProject({
    'api.py': "if __name__ == '__main__':\n    app.run(debug=True)\n",
  });
  try {
    const cas = await new CliAnalyzer().analyze({ projectPath: dir });
    assert.equal(cas.entry_points.length, 1);
    assert.notEqual(cas.entry_points[0].handler?.method_name, 'main');
    assert.equal(cas.entry_points[0].handler?.node_id, cas.entry_points[0].source_node);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
