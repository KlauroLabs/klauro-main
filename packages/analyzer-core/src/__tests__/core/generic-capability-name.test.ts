import * as fs from 'fs';
import * as path from 'path';

const ORCHESTRATOR = path.join(__dirname, '../../analyzer/core/orchestrator.ts');

describe('isGenericCapabilityDisplayName carries no repo-specific vocabulary', () => {
  const source = fs.readFileSync(ORCHESTRATOR, 'utf8');
  const body = (() => {
    const start = source.indexOf('private isGenericCapabilityDisplayName');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\n  private ', start + 10);
    return source.slice(start, end === -1 ? source.length : end);
  })();

  // These six capabilities DROP a capability from the customer-facing catalog, so
  // a word list here decides what a customer never sees. Three literal phrases
  // and one framework's class names were in this predicate with no test proving
  // any of them — the shape of "a lane needed a decision and a literal list was
  // the fastest way to get it". Removed; this asserts they stay gone.
  it('does not suppress specific observed output phrases', () => {
    expect(body).not.toMatch(/help management/i);
    expect(body).not.toMatch(/report reporting/i);
    expect(body).not.toMatch(/jobs\?? workflow/i);
    expect(body).not.toMatch(/dismiss/i);
  });

  it('does not name one web framework\'s components', () => {
    // Framework machinery must be recognised from evidence (the code is owned by
    // a framework path / dependency), never from that framework's brand nouns —
    // a name list only ever covers the frameworks someone happened to hit.
    expect(body).not.toMatch(/action[_\s]?text/i);
    expect(body).not.toMatch(/active[_\s]?storage/i);
    expect(body).not.toMatch(/action[_\s]?cable/i);
    expect(body).not.toMatch(/action[_\s]?mailbox/i);
    expect(body).not.toMatch(/bin\\?\/console/i);
  });

  it('still rejects names carrying code syntax, which no capability name has', () => {
    // The structural half of the predicate, kept: punctuation and member access
    // are evidence the label came from an identifier, not from an outcome.
    expect(body).toMatch(/\[\(\)/);
    expect(body).toMatch(/\\\.with/);
  });

  it('still rejects mechanism nouns that name a dispatch shape, not an outcome', () => {
    for (const mechanism of ['handlers', 'console commands']) {
      expect(body.toLowerCase()).toContain(mechanism);
    }
  });
});
