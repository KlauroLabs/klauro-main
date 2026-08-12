import {
  capabilityInteractionPhrase,
  capabilityVerbClause,
  entryPointSurfaceLabel,
  generateCapabilityDescription,
  generateTerminalCapabilityDescription,
  joinHumanList,
  lastResortCapabilityDescription,
  relativizeRepoPath,
} from '../../analyzer/core/capability-description';
import { CASDataEntity, CASEntryPoint } from '../../types/cas.types';

const entity = (name: string) => ({ name } as CASDataEntity);
const entryPoint = (file: string) => ({ handler: { file } } as unknown as CASEntryPoint);

describe('joinHumanList', () => {
  it('renders zero, one, two and three items without a stray comma or "and"', () => {
    expect(joinHumanList([])).toBe('');
    expect(joinHumanList(['a'])).toBe('a');
    expect(joinHumanList(['a', 'b'])).toBe('a and b');
    expect(joinHumanList(['a', 'b', 'c'])).toBe('a, b, and c');
  });

  it('drops blank entries rather than emitting an empty slot', () => {
    expect(joinHumanList(['a', '  ', 'b'])).toBe('a and b');
  });
});

describe('relativizeRepoPath', () => {
  it('strips the project root so a stored path is repo-relative', () => {
    expect(relativizeRepoPath('/repo/src/a.ts', '/repo')).toBe('src/a.ts');
  });

  it('keeps only the last two segments of an absolute path outside the root', () => {
    expect(relativizeRepoPath('/elsewhere/deep/nested/a.ts', '/repo')).toBe('nested/a.ts');
  });

  it('leaves an already-relative path alone and normalises separators', () => {
    expect(relativizeRepoPath('src/a.ts', '/repo')).toBe('src/a.ts');
    expect(relativizeRepoPath('src\\a.ts', '/repo')).toBe('src/a.ts');
  });

  it('never leaks an absolute path when no root is known', () => {
    expect(relativizeRepoPath('/repo/src/a.ts', undefined)).toBe('src/a.ts');
  });
});

describe('capabilityVerbClause', () => {
  it('orders CRUD verbs consistently regardless of input order', () => {
    expect(capabilityVerbClause(['delete', 'create', 'read'])).toBe('creates, reads, and deletes');
  });

  it('treats query as a read', () => {
    expect(capabilityVerbClause(['query'])).toBe('reads');
  });

  it('falls back to a single non-CRUD verb only when no CRUD action is present', () => {
    expect(capabilityVerbClause(['analyze'])).toBe('analyzes');
    expect(capabilityVerbClause(['create', 'analyze'])).toBe('creates');
  });

  it('returns empty for actions it cannot phrase, rather than inventing one', () => {
    expect(capabilityVerbClause(['frobnicate'])).toBe('');
    expect(capabilityVerbClause([])).toBe('');
  });
});

describe('entryPointSurfaceLabel', () => {
  it('pluralises on count and maps route to HTTP', () => {
    expect(entryPointSurfaceLabel('http', 1)).toBe('HTTP route');
    expect(entryPointSurfaceLabel('route', 3)).toBe('HTTP routes');
  });

  it('falls back to a generic surface for an unknown type', () => {
    expect(entryPointSurfaceLabel('quantum', 1)).toBe('operation');
    expect(entryPointSurfaceLabel('quantum', 2)).toBe('operations');
  });
});

describe('capabilityInteractionPhrase', () => {
  it('caps at three phrases and returns empty when nothing matches', () => {
    const phrase = capabilityInteractionPhrase(['http', 'page', 'cli', 'event', 'schedule']);
    expect(phrase.split(',').length).toBeLessThanOrEqual(3);
    expect(capabilityInteractionPhrase(['nothing-known'])).toBe('');
  });
});

describe('lastResortCapabilityDescription', () => {
  it('names the capability and claims nothing it has not resolved', () => {
    const text = lastResortCapabilityDescription('View Findings (Report)');
    expect(text.startsWith('View Findings is')).toBe(true);
    expect(text).toContain('no operations or related data entities have been resolved');
  });
});

describe('generateCapabilityDescription', () => {
  it('states the entities it manages and the surfaces it is reached through', () => {
    const text = generateCapabilityDescription(
      'Order Management',
      [{ action: 'create', entry_point_type: 'http' }, { action: 'read', entry_point_type: 'http' }],
      [entity('Order')],
      [entryPoint('/repo/src/orders.ts')],
      '/repo',
    );
    expect(text).toContain('creates and reads Order');
    expect(text).toContain('2 HTTP routes');
    expect(text).toContain('src/orders.ts');
  });

  it('says the behaviour is unverified when nothing resolved, instead of implying capability', () => {
    const text = generateCapabilityDescription('Mystery Thing', [], [], [], '/repo');
    expect(text).toContain('no entry points or data entities were resolved');
    expect(text).toContain('unverified');
  });

  it('never embeds an absolute path in customer-visible prose', () => {
    const text = generateCapabilityDescription(
      'Order Management',
      [{ action: 'read', entry_point_type: 'http' }],
      [entity('Order')],
      [entryPoint('/repo/src/orders.ts')],
      '/repo',
    );
    expect(text).not.toContain('/repo/');
  });
});

describe('generateTerminalCapabilityDescription', () => {
  it('draws its sample paths from operations and marks them as examples', () => {
    const text = generateTerminalCapabilityDescription(
      'Invoice Settlement',
      [entity('Invoice')],
      [{ action: 'update', entry_point_type: 'http', path_or_command: '/repo/src/invoice.ts' } as never],
      '/repo',
    );
    expect(text).toContain('updates Invoice');
    expect(text).toContain('e.g. src/invoice.ts');
  });

  it('skips synthetic entry ids rather than showing them as file paths', () => {
    const text = generateTerminalCapabilityDescription(
      'Invoice Settlement',
      [entity('Invoice')],
      [{ action: 'update', entry_point_type: 'http', path_or_command: 'entry_abc123' } as never],
      '/repo',
    );
    expect(text).not.toContain('entry_abc123');
  });
});
