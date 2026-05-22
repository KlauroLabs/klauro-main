import { DomainExtractor } from '../../analyzer/core/domain-extractor';
import { CASNode, CASEntryPoint, CASDataEntity } from '../../types/cas.types';

function node(id: string, name: string, extra: Partial<CASNode> = {}): CASNode {
  return { id, name, type: 'function', ...extra } as CASNode;
}

function entryPoint(id: string, name: string, path?: string): CASEntryPoint {
  return {
    id,
    name,
    type: 'http',
    trigger: path ? { path } : undefined,
  } as CASEntryPoint;
}

function entity(id: string, name: string, fields: string[] = []): CASDataEntity {
  return {
    id,
    name,
    fields: fields.map(f => ({ name: f })),
  } as CASDataEntity;
}

function nodesNamed(name: string, count: number, prefix = 'n'): CASNode[] {
  return Array.from({ length: count }, (_, i) => node(`${prefix}_${i}`, name));
}

describe('DomainExtractor', () => {
  const extractor = new DomainExtractor();

  it('classifies infrastructure terms as infrastructure', () => {
    const concepts = extractor.extract(nodesNamed('cache', 6), [], []);
    const cache = concepts.find(c => c.name === 'cache');
    expect(cache).toBeDefined();
    expect(cache!.classification).toBe('infrastructure');
  });

  it('excludes concepts that appear fewer than twice', () => {
    const concepts = extractor.extract([node('n1', 'payment')], [], []);
    expect(concepts.find(c => c.name === 'payment')).toBeUndefined();
  });

  it('classifies a boundary-anchored concept as core', () => {
    // "invoice" appears in both an entry point and a data entity.
    const concepts = extractor.extract(
      [node('n1', 'invoice'), node('n2', 'invoice')],
      [entryPoint('e1', 'invoice', '/invoice')],
      [entity('ent1', 'invoice', ['amount'])],
    );
    const invoice = concepts.find(c => c.name === 'invoice');
    expect(invoice).toBeDefined();
    expect(invoice!.classification).toBe('core');
  });

  it('classifies a prominence-dominant concept as core without any boundary', () => {
    // "payment" pervades the codebase but touches no entry point or entity.
    const concepts = extractor.extract(
      [...nodesNamed('payment', 8), ...nodesNamed('audit', 2, 'a')],
      [],
      [],
    );
    const payment = concepts.find(c => c.name === 'payment');
    expect(payment).toBeDefined();
    expect(payment!.classification).toBe('core');
  });

  it('lets prominence override the cross-cutting hint (token in a token system)', () => {
    // `token` is normally a supporting cross-cutting concern, but here it
    // dominates the codebase and must be core.
    const concepts = extractor.extract(nodesNamed('token', 12), [], []);
    const token = concepts.find(c => c.name === 'token');
    expect(token).toBeDefined();
    expect(token!.classification).toBe('core');
  });

  it('filters programming-noise and framework names', () => {
    const concepts = extractor.extract(
      [
        ...nodesNamed('self', 5, 's'),
        ...nodesNamed('dummy', 5, 'd'),
        ...nodesNamed('react', 5, 'r'),
        ...nodesNamed('express', 5, 'e'),
        ...nodesNamed('constructor', 5, 'c'),
      ],
      [],
      [],
    );
    const names = concepts.map(c => c.name);
    expect(names).not.toContain('self');
    expect(names).not.toContain('dummy');
    expect(names).not.toContain('react');
    expect(names).not.toContain('express');
    expect(names).not.toContain('constructor');
  });

  it('promotes prominent concepts to core when a repo has no boundary anchors', () => {
    // A CLI/bot-style repo: no entry points, no entities. Every concept is
    // structurally "supporting" by the strict rules — the promotion net must
    // still surface a core set.
    const concepts = extractor.extract(
      [
        ...nodesNamed('wallet', 3, 'w'),
        ...nodesNamed('liquidity', 3, 'l'),
        ...nodesNamed('swap', 3, 's'),
        ...nodesNamed('arbitrage', 3, 'a'),
      ],
      [],
      [],
    );
    const core = concepts.filter(c => c.classification === 'core');
    expect(core.length).toBeGreaterThan(0);
  });

  it('returns concepts sorted by frequency descending', () => {
    const concepts = extractor.extract(
      [...nodesNamed('payment', 9, 'p'), ...nodesNamed('refund', 3, 'r')],
      [],
      [],
    );
    for (let i = 1; i < concepts.length; i++) {
      expect(concepts[i - 1].frequency).toBeGreaterThanOrEqual(concepts[i].frequency);
    }
  });
});
