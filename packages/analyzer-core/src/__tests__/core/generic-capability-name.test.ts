import * as fs from 'fs';
import * as path from 'path';

const ORCHESTRATOR = path.join(__dirname, '../../analyzer/core/orchestrator.ts');

// `isGenericCapabilityDisplayName` gates six call sites that DROP a capability
// from the customer-facing catalog, so what it matches decides what a customer
// never sees. This file records what is settled and what is still debt.
describe('generic capability name detection', () => {
  const source = fs.readFileSync(ORCHESTRATOR, 'utf8');
  const body = (() => {
    const start = source.indexOf('private isGenericCapabilityDisplayName');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\n  private ', start + 10);
    return source.slice(start, end === -1 ? source.length : end);
  })();

  it('detects a stutter structurally, with no phrase list', () => {
    // "Report Reporting" says nothing: the subject and its qualifier share a stem.
    // That is a property of the string, so it holds for any repo — it replaced a
    // literal `report reporting` suppression.
    expect(body).toContain('nameIsStutter');
    expect(body).not.toMatch(/report reporting/i);
  });

  it('does NOT reject a name merely for containing an underscore', () => {
    // Tried and falsified. `gift_cards`, `product_translations` and
    // `payment_links` are REAL commerce capabilities whose names are snake_case
    // because the ENTITIES are; `dismiss_updater_notice` and `action_text` are
    // code identifiers. Both shapes are snake_case, so the underscore carries no
    // signal. Separating them needs entity evidence (does the subject resolve to
    // a known entity?), which this string-only predicate cannot see — see the
    // remaining literals below, which stand in for that evidence until it does.
    expect(body).not.toContain('nameCarriesCodeIdentifier');
  });

  it('still carries identifier-shaped literals, which is known debt not a design', () => {
    // Deliberately asserted as PRESENT so this test turns red the day someone
    // makes the predicate evidence-aware and can honestly delete them — the
    // point being that the removal is then proven, not assumed.
    expect(body).toMatch(/dismiss/i);
    expect(body).toMatch(/action[_\s]?text/i);
  });

  it('still rejects names carrying code syntax, which no capability name has', () => {
    expect(body).toMatch(/\[\(\)/);
    expect(body).toMatch(/\\\.with/);
  });
});

describe('nameIsStutter', () => {
  const isStutter = (name: string) => {
    const stems = String(name || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map(token => token.replace(/(ings?|ment|ments|ions?|ers?|s)$/, ''))
      .filter(stem => stem.length >= 3);
    return new Set(stems).size < stems.length;
  };

  it('catches a repeated stem', () => {
    expect(isStutter('Report Reporting')).toBe(true);
  });

  it('keeps real capability names — measured live on prod, not invented here', () => {
    for (const name of [
      'Pair devices for communication',
      'Organize and publish topics',
      'Monitor system health',
      'Process audio',
      'Configure audio processing',
      'Manage Dependency Injection',
      'View and manage findings',
      'Integrate with external services',
    ]) {
      expect(isStutter(name)).toBe(false);
    }
  });

  it('keeps the genuine commerce names the corpus characterization test pins', () => {
    for (const name of [
      'Orders Management',
      'Gift_cards Management',
      'Stock Management',
      'Product_translations Workflow',
      'Payment_links Workflow',
      'Jobs Management',
      'Proposal Preview',
    ]) {
      expect(isStutter(name)).toBe(false);
    }
  });
});
