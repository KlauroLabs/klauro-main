import { describe, it, expect } from 'vitest';
import { encodeSlug, resolveSlug, legacyIdMatch, kebabCase, idSuffix } from './slugs';

describe('slugs', () => {
  it('kebab-cases names and falls back to "item" for an empty/symbol-only name', () => {
    expect(kebabCase('Proof of Concept')).toBe('proof-of-concept');
    expect(kebabCase('  Klauro!! ')).toBe('klauro');
    expect(kebabCase('***')).toBe('item');
  });

  it('derives a stable 6-char alnum suffix regardless of id punctuation scheme', () => {
    expect(idSuffix('wsp_PWXpXfnPgDnf6lBC')).toBe('nf6lbc');
    expect(idSuffix('flow::chain:entry_event_x')).toBe('eventx');
  });

  it('round-trips encode -> resolve for a single candidate', () => {
    const item = { id: 'prj_wbW33m-wfETn1N41', name: 'proof-of-concept' };
    const slug = encodeSlug(item);
    expect(slug).toMatch(/^proof-of-concept~[a-z0-9]{1,6}$/);
    expect(resolveSlug(slug, [item])).toBe(item);
  });

  it('resolves a legacy raw-id param back-compat', () => {
    const item = { id: 'wsp_PWXpXfnPgDnf6lBC', name: 'Klauro' };
    expect(resolveSlug(item.id, [item])).toBe(item);
  });

  it('disambiguates two candidates that share a display name by suffix', () => {
    const a = { id: 'wsp_aaaaaaaaaa1111', name: 'Acme' };
    const b = { id: 'wsp_bbbbbbbbbb2222', name: 'Acme' };
    const slugA = encodeSlug(a);
    const slugB = encodeSlug(b);
    expect(slugA).not.toBe(slugB);
    expect(resolveSlug(slugA, [a, b])).toBe(a);
    expect(resolveSlug(slugB, [a, b])).toBe(b);
  });

  it('resolves by suffix alone when the name portion is stale', () => {
    const item = { id: 'wsp_aaaaaaaaaa1111', name: 'Acme' };
    const staleSlug = `acme-renamed~${idSuffix(item.id)}`;
    expect(resolveSlug(staleSlug, [item])).toBe(item);
  });

  it('returns undefined for an unresolvable param (candidates not loaded yet)', () => {
    expect(resolveSlug('acme~zzzzzz', [])).toBeUndefined();
    expect(resolveSlug(undefined, [{ id: 'a', name: 'A' }])).toBeUndefined();
  });

  it('flags a legacy raw-id link that does not match its canonical slug form', () => {
    const item = { id: 'wsp_PWXpXfnPgDnf6lBC', name: 'Klauro' };
    expect(legacyIdMatch(item.id, [item])).toBe(item);
    expect(legacyIdMatch(encodeSlug(item), [item])).toBeUndefined();
  });
});
