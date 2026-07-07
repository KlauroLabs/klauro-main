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
    // The full meaningful phrase is preserved rather than truncated to a
    // single leading word ("coordinator" alone would drop "keepalive" and is
    // the same truncation bug that produced malformed capability names like
    // "Monte Management" from "Monte Carlo").
    expect(orchestrator.domainKeyFromEntryPointText('coordinator_keepalive')).toBe('coordinator-keepalive');
  });
});

test('dns and tls survive as domain nouns for network products', () => {
  const { isLanguageBuiltinDomainToken } = require('../../analyzer/core/language-builtins');
  expect(isLanguageBuiltinDomainToken('dns')).toBe(false);
  expect(isLanguageBuiltinDomainToken('tls')).toBe(false);
  expect(isLanguageBuiltinDomainToken('fmt')).toBe(true);
});

describe('isCapabilityNoiseToken', () => {
  const { isCapabilityNoiseToken } = require('../../analyzer/core/language-builtins');

  it('rejects pure-numeric tokens such as IP octets and ports', () => {
    for (const token of ['172', '192', '8080', '443', '12345']) {
      expect(isCapabilityNoiseToken(token)).toBe(true);
    }
  });

  it('rejects numeric-leading tokens that are not technology names', () => {
    for (const token of ['172xyz', '24h', '0x1f']) {
      expect(isCapabilityNoiseToken(token)).toBe(true);
    }
  });

  it('keeps digit-led technology tokens that anchor real domains', () => {
    for (const token of ['2fa', '3ds', '5g', 'i18n', 'a11y']) {
      expect(isCapabilityNoiseToken(token)).toBe(false);
    }
  });

  it('rejects qualifier and hedge words that carry no domain meaning', () => {
    for (const token of ['likely', 'maybe', 'probably', 'possibly', 'unknown', 'misc', 'temp', 'new', 'old', 'common', 'util', 'utils']) {
      expect(isCapabilityNoiseToken(token)).toBe(true);
    }
  });

  it('keeps real product-domain tokens intact', () => {
    for (const token of ['dns', 'scan', 'coordinator', 'credential', 'nmap', 'certificate', 'arp']) {
      expect(isCapabilityNoiseToken(token)).toBe(false);
    }
  });
});

describe('capability tokenizers reject numeric and qualifier noise', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;

  it('never seeds a capability from an IP fragment or a hedge word', () => {
    expect(orchestrator.domainTokensFromText('172_16_0_0')).toEqual([]);
    expect(orchestrator.domainTokensFromText('likely')).toEqual([]);
    expect(orchestrator.domainTokensFromText('likely_host')).toEqual(['host']);
    expect(orchestrator.domainKeyFromEntryPointText('172')).toBeUndefined();
    expect(orchestrator.domainKeyFromEntryPointText('likely')).toBeUndefined();
  });

  it('keeps digit-led technology tokens as domain anchors', () => {
    expect(orchestrator.domainTokensFromText('enable_2fa')).toEqual(['enable', '2fa']);
    // Full phrase preserved instead of truncated to the first token alone.
    expect(orchestrator.domainKeyFromEntryPointText('2fa_enrollment')).toBe('2fa-enrollment');
  });
});

describe('UI state and serialization plumbing capability noise', () => {
  const { isCapabilityNoiseToken } = require('../../analyzer/core/language-builtins');
  const orchestrator = new AnalyzerOrchestrator() as any;

  it('rejects CSS/DOM state adjectives that seed junk theme capabilities', () => {
    for (const token of ['inner', 'active', 'connected', 'predictive', 'hover', 'hovered', 'focused', 'selected', 'expanded', 'collapsed', 'hidden', 'visible', 'sticky', 'disabled', 'enabled']) {
      expect(isCapabilityNoiseToken(token)).toBe(true);
    }
  });

  it('rejects serialization plumbing verbs that seed serde capabilities', () => {
    for (const token of ['serialize', 'deserialize', 'serialized', 'deserialized', 'encode', 'decode', 'marshal', 'unmarshal']) {
      expect(isCapabilityNoiseToken(token)).toBe(true);
    }
  });

  it('keeps real product-domain tokens that neighbor the new noise classes', () => {
    for (const token of ['token', 'wallet', 'cart', 'checkout', 'product', 'directory', 'activity', 'connection']) {
      expect(isCapabilityNoiseToken(token)).toBe(false);
    }
  });

  it('never seeds a capability name from UI state or serde tokens', () => {
    expect(orchestrator.domainTokensFromText('inner')).toEqual([]);
    expect(orchestrator.domainTokensFromText('predictive')).toEqual([]);
    expect(orchestrator.domainTokensFromText('deserialize_instruction')).toEqual(['instruction']);
    expect(orchestrator.domainKeyFromEntryPointText('active_menu_toggle')).toBe('menu');
    expect(orchestrator.domainKeyFromEntryPointText('serialize')).toBeUndefined();
  });

  it('keeps Token Authentication style capabilities seeded from real domain nouns', () => {
    expect(orchestrator.domainTokensFromText('TokenAuth')).toEqual(['token', 'auth']);
    expect(orchestrator.domainTokensFromText('WalletService')).toEqual(['wallet']);
  });
});

describe('isVendorLibDomainToken', () => {
  const { isVendorLibDomainToken } = require('../../analyzer/core/language-builtins');

  it('flags vendor/infrastructure library tokens', () => {
    for (const token of ['jito', 'Jito', ' borsh ']) {
      expect(isVendorLibDomainToken(token)).toBe(true);
    }
  });

  it('keeps product and chain tokens that carry domain meaning', () => {
    for (const token of ['solana', 'wallet', 'token', 'pool', 'anchor', undefined, '']) {
      expect(isVendorLibDomainToken(token as any)).toBe(false);
    }
  });
});
