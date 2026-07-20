import { describe, it, expect } from 'vitest';
import { formatTrigger, looksLikeRawToken, securityLabel } from './formatEntryPoint';
import type { EntryPoint } from '../../hooks/useEntryPoints';

function ep(overrides: Partial<EntryPoint>): EntryPoint {
  return { id: 'e1', source_node: 'n1', type: 'http', name: 'x', ...overrides };
}

describe('formatTrigger', () => {
  it('formats method + path', () => {
    expect(formatTrigger(ep({ trigger: { method: 'post', path: '/v1/analyze' } }))).toBe('POST /v1/analyze');
  });
  it('formats a schedule in words', () => {
    expect(formatTrigger(ep({ trigger: { schedule: 'every day at 02:00 UTC' } }))).toBe('every day at 02:00 UTC');
  });
  it('formats an event name', () => {
    expect(formatTrigger(ep({ trigger: { event: 'analysis.completed' } }))).toBe('on "analysis.completed"');
  });
  it('returns null when there is no trigger data at all', () => {
    expect(formatTrigger(ep({}))).toBeNull();
  });
});

describe('looksLikeRawToken', () => {
  it('flags snake_case code names', () => {
    expect(looksLikeRawToken('handle_request')).toBe(true);
  });
  it('flags bare single-word identifiers', () => {
    expect(looksLikeRawToken('main')).toBe(true);
  });
  it('does not flag a clean phrase', () => {
    expect(looksLikeRawToken('Analyze a codebase')).toBe(false);
  });
});

describe('securityLabel', () => {
  it('labels an authenticated entry point as protected', () => {
    expect(securityLabel(ep({ security: { authenticated: true } }))).toEqual({ label: 'Protected', open: false });
  });
  it('labels an explicitly public entry point as open', () => {
    expect(securityLabel(ep({ security: { authenticated: false } }))).toEqual({ label: 'Open to anyone', open: true });
  });
  it('labels missing security evidence as unknown, never silently public', () => {
    expect(securityLabel(ep({}))).toEqual({ label: 'Unknown', open: true });
  });
});
