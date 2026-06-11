import {
  isLanguageBuiltinDomainToken,
  isLanguageBuiltinName,
  isLanguageBuiltinExitPoint,
} from '../../analyzer/core/language-builtins';
import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { CASNode } from '../../types/cas.types';

describe('isLanguageBuiltinDomainToken', () => {
  it('filters Rust stdlib module and macro tokens', () => {
    for (const token of ['fmt', 'std', 'vec', 'iter', 'collections', 'str', 'slice', 'mem', 'ffi']) {
      expect(isLanguageBuiltinDomainToken(token)).toBe(true);
    }
  });

  it('filters Rust keywords and source-layout module names', () => {
    for (const token of ['lib', 'mod', 'main', 'impl', 'mut', 'crate', 'trait', 'spawn', 'derive']) {
      expect(isLanguageBuiltinDomainToken(token)).toBe(true);
    }
  });

  it('filters Go standard library package names', () => {
    for (const token of ['fmt', 'strconv', 'bufio', 'errors', 'regexp', 'filepath', 'ioutil', 'pkg', 'cmd']) {
      expect(isLanguageBuiltinDomainToken(token)).toBe(true);
    }
  });

  it('filters Python standard library module names', () => {
    for (const token of ['asyncio', 'pathlib', 'subprocess', 'itertools', 'functools', 'dataclasses', 'sys']) {
      expect(isLanguageBuiltinDomainToken(token)).toBe(true);
    }
  });

  it('filters Node builtin module names', () => {
    for (const token of ['url', 'tty', 'zlib', 'dgram', 'child_process']) {
      expect(isLanguageBuiltinDomainToken(token)).toBe(true);
    }
  });

  it('filters platform module names used for OS-specific source files', () => {
    for (const token of ['linux', 'windows', 'darwin', 'posix']) {
      expect(isLanguageBuiltinDomainToken(token)).toBe(true);
    }
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(isLanguageBuiltinDomainToken('Fmt')).toBe(true);
    expect(isLanguageBuiltinDomainToken(' lib ')).toBe(true);
    expect(isLanguageBuiltinDomainToken('MOD')).toBe(true);
  });

  it('keeps real domain tokens', () => {
    for (const token of ['agent', 'coordinator', 'peer', 'session', 'keepalive', 'scan', 'notification', 'payment', 'invoice']) {
      expect(isLanguageBuiltinDomainToken(token)).toBe(false);
    }
  });

  it('keeps lowercase forms of capitalized-only builtins that are ordinary domain nouns', () => {
    for (const token of ['task', 'file', 'command', 'option', 'result', 'duration', 'directory']) {
      expect(isLanguageBuiltinDomainToken(token)).toBe(false);
    }
  });

  it('keeps builtin names that double as common product-domain nouns', () => {
    for (const token of ['todo', 'crypto', 'stream', 'events', 'cluster']) {
      expect(isLanguageBuiltinDomainToken(token)).toBe(false);
    }
  });

  it('handles undefined and empty input', () => {
    expect(isLanguageBuiltinDomainToken(undefined)).toBe(false);
    expect(isLanguageBuiltinDomainToken('')).toBe(false);
  });

  it('does not widen exit-point builtin classification to boundary-crossing modules', () => {
    expect(isLanguageBuiltinName('subprocess')).toBe(false);
    expect(isLanguageBuiltinName('urllib')).toBe(false);
    expect(isLanguageBuiltinExitPoint({ name: 'External call: subprocess', target: undefined })).toBe(false);
  });
});

describe('capability clustering builtin token filtering', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;

  const makeNode = (name: string, file: string, type = 'method'): CASNode => ({
    id: `node_${name}_${file}`,
    type,
    name,
    source: { file, line_start: 1, line_end: 10 },
  } as unknown as CASNode);

  it('never seeds a domain key from Rust builtin method names like fmt', () => {
    const node = makeNode('fmt', 'bin/agent/src/agent/nat.rs');
    expect(orchestrator.domainKeyFromNode(node)).toBe('nat');
  });

  it('never seeds a domain key from lib.rs or mod.rs file nodes', () => {
    expect(orchestrator.domainKeyFromNode(makeNode('lib.rs', 'bin/coordinator/src/lib.rs', 'file'))).toBe('coordinator');
    expect(orchestrator.domainKeyFromNode(makeNode('mod.rs', 'bin/agent/src/tasks/mod.rs', 'file'))).toBe('tasks');
  });

  it('drops builtin-derived tokens while keeping domain tokens in mixed names', () => {
    expect(orchestrator.domainTokensFromText('spawn_keepalive_task')).toEqual(['keepalive', 'task']);
    expect(orchestrator.domainTokensFromText('as_mut_slice')).toEqual([]);
    expect(orchestrator.domainTokensFromText('fmt')).toEqual([]);
    expect(orchestrator.domainTokensFromText('url')).toEqual([]);
  });

  it('keeps real zerac-style domain tokens intact', () => {
    expect(orchestrator.domainTokensFromText('coordinator_registration_task')[0]).toBe('coordinator');
    expect(orchestrator.domainTokensFromText('PeerSession')[0]).toBe('peer');
  });

  it('never seeds entry-point resource keys from builtin tokens', () => {
    expect(orchestrator.domainKeyFromEntryPointText('tty')).toBeUndefined();
    expect(orchestrator.domainKeyFromEntryPointText('spawn')).toBeUndefined();
    expect(orchestrator.domainKeyFromEntryPointText('fmt')).toBeUndefined();
    expect(orchestrator.domainKeyFromEntryPointText('coordinator_keepalive')).toBe('coordinator');
  });
});

test('dns and tls survive as domain nouns for network products', () => {
  const { isLanguageBuiltinDomainToken } = require('../../analyzer/core/language-builtins');
  expect(isLanguageBuiltinDomainToken('dns')).toBe(false);
  expect(isLanguageBuiltinDomainToken('tls')).toBe(false);
  expect(isLanguageBuiltinDomainToken('fmt')).toBe(true);
});
