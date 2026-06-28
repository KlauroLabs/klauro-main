import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { AnchorAnalyzer } from './anchor-analyzer';

async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anchor-analyzer-test-'));
  const src = path.join(dir, 'programs', 'myprog', 'src');
  await fs.ensureDir(src);

  await fs.writeFile(path.join(dir, 'Anchor.toml'), `[programs.localnet]
myprog = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"

[provider]
cluster = "localnet"
`, 'utf-8');

  await fs.writeFile(path.join(dir, 'programs', 'myprog', 'Cargo.toml'), `[package]
name = "myprog"
version = "0.1.0"
edition = "2021"

[dependencies]
anchor-lang = "0.30.0"
`, 'utf-8');

  await fs.writeFile(path.join(src, 'lib.rs'), `use anchor_lang::prelude::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod myprog {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, amount: u64) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = user, space = 8 + 8)]
    pub state: Account<'info, Vault>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Vault {
    pub amount: u64,
}

#[event]
pub struct Deposited {
    pub amount: u64,
}
`, 'utf-8');

  return dir;
}

test('AnchorAnalyzer extracts program, instructions, accounts, state, events and links', async () => {
  const projectPath = await makeProject();
  try {
    const analyzer = new AnchorAnalyzer();

    assert.strictEqual(await analyzer.canAnalyze(projectPath), true, 'canAnalyze should be true');

    const cas = await analyzer.analyze({ projectPath });
    const nodes = cas.nodes || [];
    const edges = cas.edges || [];
    const entryPoints = cas.entry_points || [];

    // Program node
    const program = nodes.find(n => n.type === 'anchor-program' && n.name === 'myprog');
    assert.ok(program, 'program node myprog should exist');

    // Instruction node
    const instr = nodes.find(n => n.type === 'anchor-instruction' && n.name === 'initialize');
    assert.ok(instr, 'instruction node initialize should exist');
    assert.strictEqual((instr!.metadata as any)?.context_type, 'Initialize',
      'instruction should capture its Context type Initialize');

    // Instruction is an entry point
    const ep = entryPoints.find(e => e.metadata?.instruction === 'initialize' && e.metadata?.framework === 'anchor');
    assert.ok(ep, 'initialize should be an entry point');
    assert.strictEqual(ep!.metadata?.context_type, 'Initialize', 'entry point should record context type');

    // Accounts context struct + its fields
    const accCtx = nodes.find(n => n.type === 'anchor-accounts' && n.name === 'Initialize');
    assert.ok(accCtx, 'Accounts context Initialize should exist');
    const accFields = nodes.filter(n => n.type === 'anchor-account-ref' && n.metadata?.context === 'Initialize');
    const fieldNames = accFields.map(n => n.name).sort();
    assert.deepStrictEqual(fieldNames, ['state', 'system_program', 'user'], 'Initialize account fields');
    assert.ok(accFields.find(n => n.name === 'user' && n.metadata?.account_role === 'signer'), 'user is a signer');
    assert.ok(accFields.find(n => n.name === 'system_program' && n.metadata?.account_role === 'program'), 'system_program is a program');
    assert.ok(accFields.find(n => n.name === 'state' && n.metadata?.is_init === true), 'state is init');

    // State account => data entity
    const vault = nodes.find(n => n.type === 'data-entity' && n.name === 'Vault');
    assert.ok(vault, 'state account Vault should be a data entity');
    assert.strictEqual(vault!.metadata?.anchor_kind, 'state-account', 'Vault tagged as state-account');

    // Event
    const deposited = nodes.find(n => n.type === 'anchor-event' && n.name === 'Deposited');
    assert.ok(deposited, 'event Deposited should exist');

    // Instruction linked to its Initialize context via uses-accounts edge
    const link = edges.find(e =>
      e.type === 'uses-accounts' &&
      e.source === instr!.id &&
      e.target === accCtx!.id
    );
    assert.ok(link, 'instruction initialize should link to Initialize accounts context');

    // Program contains instruction edge
    const contains = edges.find(e => e.type === 'contains' && e.source === program!.id && e.target === instr!.id);
    assert.ok(contains, 'program should contain instruction');
  } finally {
    await fs.remove(projectPath);
  }
});
