import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { TauriAnalyzer } from './tauri-analyzer';

/**
 * Fixture shape mirrors a real Tauri v2 app: a `src-tauri/Cargo.toml` depending on
 * `tauri`, Rust commands marked `#[tauri::command]`, a `tauri::generate_handler![...]`
 * registration in `main.rs`, and a frontend `invoke('cmd')` call site using
 * `@tauri-apps/api/core`.
 */
async function makeTauriFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tauri-analyzer-'));

  await fs.writeJson(path.join(root, 'package.json'), {
    name: 'tauri-fixture',
    dependencies: { '@tauri-apps/api': '^2.0.0' },
  });

  await fs.ensureDir(path.join(root, 'src-tauri', 'src'));
  await fs.writeFile(
    path.join(root, 'src-tauri', 'Cargo.toml'),
    `[package]
name = "tauri-fixture"
version = "0.1.0"

[dependencies]
tauri = { version = "2.0.0", features = [] }
`
  );

  await fs.writeFile(
    path.join(root, 'src-tauri', 'src', 'main.rs'),
    `mod commands;
use commands::{get_profile, log_out};

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_profile, log_out])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
`
  );

  await fs.writeFile(
    path.join(root, 'src-tauri', 'src', 'commands.rs'),
    `#[tauri::command]
pub async fn get_profile() -> Result<String, String> {
    Ok("profile".into())
}

#[tauri::command]
pub fn log_out() {
    std::process::exit(0);
}
`
  );

  await fs.ensureDir(path.join(root, 'src'));
  await fs.writeFile(
    path.join(root, 'src', 'auth.ts'),
    `import { invoke } from '@tauri-apps/api/core'

export const getProfile = () => invoke('get_profile')
export const logOut = () => invoke('log_out')
`
  );

  return root;
}

test('TauriAnalyzer canAnalyze detects tauri crate + command usage', async () => {
  const root = await makeTauriFixture();
  try {
    const analyzer = new TauriAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), true);
  } finally {
    await fs.remove(root);
  }
});

test('TauriAnalyzer canAnalyze is false without tauri evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tauri-analyzer-none-'));
  try {
    await fs.writeJson(path.join(root, 'package.json'), { name: 'no-tauri', dependencies: { react: '^18.0.0' } });
    const analyzer = new TauriAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), false);
  } finally {
    await fs.remove(root);
  }
});

test('TauriAnalyzer surfaces #[tauri::command] functions as command entry points', async () => {
  const root = await makeTauriFixture();
  try {
    const analyzer = new TauriAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });

    const commandEntries = contribution.entry_points.filter(ep => ep.type === 'command');
    assert.strictEqual(commandEntries.length, 2);

    const getProfile = commandEntries.find(ep => ep.metadata?.command === 'get_profile');
    assert.ok(getProfile, 'should emit an entry point for get_profile');
    assert.strictEqual(getProfile!.metadata?.async, true);
    assert.strictEqual(getProfile!.metadata?.registered, true);

    const logOut = commandEntries.find(ep => ep.metadata?.command === 'log_out');
    assert.ok(logOut, 'should emit an entry point for log_out');
    assert.strictEqual(logOut!.metadata?.async, false);
  } finally {
    await fs.remove(root);
  }
});

test('TauriAnalyzer resolves generate_handler! registration and links commands', async () => {
  const root = await makeTauriFixture();
  try {
    const analyzer = new TauriAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });

    const regNode = contribution.nodes.find(n => n.type === 'tauri_registration');
    assert.ok(regNode, 'should emit a generate_handler! registration node');
    assert.deepStrictEqual(regNode!.metadata?.attributes?.commands, ['get_profile', 'log_out']);

    const commandNode = contribution.nodes.find(n => n.type === 'tauri_command' && n.metadata?.attributes?.command === 'get_profile');
    assert.ok(commandNode, 'should emit the get_profile command node');

    const registersEdge = contribution.edges.find(e => e.type === 'registers' && e.source === regNode!.id && e.target === commandNode!.id);
    assert.ok(registersEdge, 'should link the registration to the command it registers');
  } finally {
    await fs.remove(root);
  }
});

test('TauriAnalyzer resolves frontend invoke() call sites to their Rust command', async () => {
  const root = await makeTauriFixture();
  try {
    const analyzer = new TauriAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });

    const invokeNode = contribution.nodes.find(n => n.type === 'tauri_invoke' && n.metadata?.attributes?.command === 'get_profile');
    assert.ok(invokeNode, 'should emit an invoke call-site node');

    const commandNode = contribution.nodes.find(n => n.type === 'tauri_command' && n.metadata?.attributes?.command === 'get_profile');
    assert.ok(commandNode);

    const invokesEdge = contribution.edges.find(e => e.type === 'invokes' && e.source === invokeNode!.id && e.target === commandNode!.id);
    assert.ok(invokesEdge, 'should link the frontend invoke() call to the Rust command by name');
  } finally {
    await fs.remove(root);
  }
});

test('TauriAnalyzer flags a command as unregistered when absent from generate_handler!', async () => {
  const root = await makeTauriFixture();
  try {
    await fs.appendFile(
      path.join(root, 'src-tauri', 'src', 'commands.rs'),
      `
#[tauri::command]
pub fn orphan_command() {}
`
    );
    const analyzer = new TauriAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root });

    const orphan = contribution.entry_points.find(ep => ep.metadata?.command === 'orphan_command');
    assert.ok(orphan, 'should still surface the unregistered command as an entry point');
    assert.strictEqual(orphan!.metadata?.registered, false);
  } finally {
    await fs.remove(root);
  }
});
