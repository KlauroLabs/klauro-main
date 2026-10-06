import {
  isLanguageBuiltinDomainToken,
  isLanguageBuiltinName,
  isLanguageBuiltinExitPoint,
} from '../../analyzer/core/language-builtins';

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
