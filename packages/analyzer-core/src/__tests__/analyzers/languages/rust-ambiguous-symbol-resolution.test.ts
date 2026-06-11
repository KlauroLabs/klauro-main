jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RustAnalyzer } from '../../../analyzer/languages/rust-analyzer';
import type { CASContribution } from '../../../types/cas.types';

jest.setTimeout(60000);

describe('Rust ambiguous symbol resolution', () => {
  let root: string;

  const write = (relative: string, content: string) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-rust-ambiguous-'));
    write('Cargo.toml', [
      '[workspace]',
      'members = ["crates/alpha", "crates/beta", "crates/zeta"]',
      '',
    ].join('\n'));
    write('crates/alpha/Cargo.toml', '[package]\nname = "alpha"\nversion = "0.1.0"\n');
    write('crates/beta/Cargo.toml', '[package]\nname = "beta"\nversion = "0.1.0"\n');
    write('crates/zeta/Cargo.toml', '[package]\nname = "zeta"\nversion = "0.1.0"\n');
    write('crates/alpha/src/error.rs', [
      'pub enum Error {',
      '    Code(u32),',
      '}',
      '',
    ].join('\n'));
    write('crates/beta/src/error.rs', [
      'pub enum Error {',
      '    Message(String),',
      '}',
      '',
    ].join('\n'));
    write('crates/alpha/src/lib.rs', [
      'pub mod error;',
      '',
      'pub fn alpha_handle() {',
      '    errors::Error::custom();',
      '}',
      '',
    ].join('\n'));
    write('crates/beta/src/lib.rs', [
      'pub mod error;',
      '',
      'pub fn beta_handle() {',
      '    errors::Error::custom();',
      '}',
      '',
    ].join('\n'));
    write('crates/zeta/src/lib.rs', [
      'pub fn zeta_handle() {',
      '    errors::Error::custom();',
      '}',
      '',
    ].join('\n'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const analyzeOnce = async (): Promise<CASContribution> => {
    return new RustAnalyzer().analyze({ projectPath: root });
  };

  const errorUsesEdge = (contribution: CASContribution, callerFile: string) => {
    return (contribution.edges || []).filter(edge =>
      edge.type === 'uses' &&
      edge.id.startsWith('uses:') &&
      /:\d+$/.test(edge.id) &&
      edge.source.includes(callerFile) &&
      /(?:struct|enum):[^:]+:Error/.test(edge.target)
    );
  };

  it('resolves an ambiguous type to the caller crate definition', async () => {
    const contribution = await analyzeOnce();

    const alphaEdges = errorUsesEdge(contribution, 'crates/alpha/src/lib.rs');
    expect(alphaEdges.length).toBeGreaterThan(0);
    for (const edge of alphaEdges) {
      expect(edge.target).toContain('crates/alpha/src/error.rs');
    }

    const betaEdges = errorUsesEdge(contribution, 'crates/beta/src/lib.rs');
    expect(betaEdges.length).toBeGreaterThan(0);
    for (const edge of betaEdges) {
      expect(edge.target).toContain('crates/beta/src/error.rs');
    }
  });

  it('falls back to the lexicographically first definition when the caller crate has none', async () => {
    const contribution = await analyzeOnce();

    const zetaEdges = errorUsesEdge(contribution, 'crates/zeta/src/lib.rs');
    expect(zetaEdges.length).toBeGreaterThan(0);
    for (const edge of zetaEdges) {
      expect(edge.target).toContain('crates/alpha/src/error.rs');
    }
  });

  it('produces identical node, edge, entry, and exit ids across repeated analyses', async () => {
    const first = await analyzeOnce();
    const second = await analyzeOnce();

    expect((second.nodes || []).map(node => node.id)).toEqual((first.nodes || []).map(node => node.id));
    expect((second.edges || []).map(edge => `${edge.id}|${edge.source}|${edge.target}`))
      .toEqual((first.edges || []).map(edge => `${edge.id}|${edge.source}|${edge.target}`));
    expect((first.edges || []).length).toBeGreaterThan(0);
    expect((second.entry_points || []).map(entry => entry.id)).toEqual((first.entry_points || []).map(entry => entry.id));
    expect((second.exit_points || []).map(exit => exit.id)).toEqual((first.exit_points || []).map(exit => exit.id));
  });

  it('resolves method call targets toward the caller file and crate first', async () => {
    const contribution = await analyzeOnce();

    const alphaCalls = (contribution.method_calls || []).filter(call =>
      call.caller_node.includes('crates/alpha/src/lib.rs') &&
      call.call_details.method_name === 'custom'
    );
    for (const call of alphaCalls) {
      if (call.target_node) {
        expect(call.target_node).not.toContain('crates/beta/');
      }
    }
  });
});

describe('Rust reclassified struct resolution', () => {
  let root: string;

  const write = (relative: string, content: string) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-rust-reclassified-'));
    write('Cargo.toml', [
      '[workspace]',
      'members = ["crates/delta", "crates/gamma", "crates/omega"]',
      '',
    ].join('\n'));
    write('crates/delta/Cargo.toml', '[package]\nname = "delta"\nversion = "0.1.0"\n');
    write('crates/gamma/Cargo.toml', '[package]\nname = "gamma"\nversion = "0.1.0"\n');
    write('crates/omega/Cargo.toml', '[package]\nname = "omega"\nversion = "0.1.0"\n');
    write('crates/delta/src/failure.rs', [
      'pub struct Error {',
      '    pub message: String,',
      '}',
      '',
    ].join('\n'));
    write('crates/gamma/src/failure.rs', [
      'pub struct Error {',
      '    pub code: u32,',
      '}',
      '',
    ].join('\n'));
    write('crates/delta/src/lib.rs', [
      'pub mod failure;',
      '',
      'pub fn delta_handle() {',
      '    failure::Error::custom();',
      '}',
      '',
    ].join('\n'));
    write('crates/gamma/src/lib.rs', [
      'pub mod failure;',
      '',
      'pub fn gamma_handle() {',
      '    failure::Error::custom();',
      '}',
      '',
    ].join('\n'));
    write('crates/omega/src/lib.rs', [
      'pub fn omega_handle() {',
      '    failure::Error::custom();',
      '}',
      '',
    ].join('\n'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const analyzeOnce = async (): Promise<CASContribution> => {
    return new RustAnalyzer().analyze({ projectPath: root });
  };

  const errorUsesEdges = (contribution: CASContribution, callerFile: string) => {
    return (contribution.edges || []).filter(edge =>
      edge.type === 'uses' &&
      edge.id.startsWith('uses:') &&
      /:\d+$/.test(edge.id) &&
      edge.source.includes(callerFile) &&
      /struct:[^:]+:Error/.test(edge.target)
    );
  };

  it('reclassifies struct Error nodes to the error type while keeping the struct id', async () => {
    const contribution = await analyzeOnce();

    const errorNodes = (contribution.nodes || []).filter(node =>
      node.id.startsWith('struct:') && node.name === 'Error'
    );
    expect(errorNodes.length).toBe(2);
    for (const node of errorNodes) {
      expect(node.type).toBe('error');
    }
  });

  it('creates uses edges to struct types reclassified to semantic node types', async () => {
    const contribution = await analyzeOnce();

    const deltaEdges = errorUsesEdges(contribution, 'crates/delta/src/lib.rs');
    expect(deltaEdges.length).toBeGreaterThan(0);
    for (const edge of deltaEdges) {
      expect(edge.target).toContain('crates/delta/src/failure.rs');
    }

    const gammaEdges = errorUsesEdges(contribution, 'crates/gamma/src/lib.rs');
    expect(gammaEdges.length).toBeGreaterThan(0);
    for (const edge of gammaEdges) {
      expect(edge.target).toContain('crates/gamma/src/failure.rs');
    }
  });

  it('falls back lexicographically for callers whose crate has no matching definition', async () => {
    const contribution = await analyzeOnce();

    const omegaEdges = errorUsesEdges(contribution, 'crates/omega/src/lib.rs');
    expect(omegaEdges.length).toBeGreaterThan(0);
    for (const edge of omegaEdges) {
      expect(edge.target).toContain('crates/delta/src/failure.rs');
    }
  });

  it('produces identical edges across repeated analyses', async () => {
    const first = await analyzeOnce();
    const second = await analyzeOnce();

    expect((second.edges || []).map(edge => `${edge.id}|${edge.source}|${edge.target}`))
      .toEqual((first.edges || []).map(edge => `${edge.id}|${edge.source}|${edge.target}`));
  });
});
