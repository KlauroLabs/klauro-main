import { describe, it, expect } from 'vitest';
import { mergeCapabilities, formatRelativeTime, formatCompactNumber } from './casSummary';
import type { ProductMapCapability, ConceptualCapability } from '../../api';

describe('mergeCapabilities', () => {
  const productMap: ProductMapCapability[] = [
    {
      name: 'Trade Execution',
      description: 'Submit, validate, and settle orders.',
      category: 'core',
      criticality: 'critical',
      entities: ['Order', 'Trade'],
      tests_present: true,
      risk_level: 'low',
    },
  ];
  const conceptual: ConceptualCapability[] = [
    {
      id: 'cap_trade_execution',
      name: 'trade execution',
      category: 'core',
      criticality: 'critical',
      related_flows: [{ flow_id: 'flow_1', role: 'primary', rationale: 'entry point' }],
    },
    {
      id: 'cap_reporting',
      name: 'Reporting & Audit',
      category: 'supporting',
      criticality: 'medium',
      related_flows: [],
    },
  ];

  it('joins product_map and conceptual capabilities by case-insensitive name', () => {
    const merged = mergeCapabilities(productMap, conceptual);
    const trade = merged.find(c => c.name === 'Trade Execution');
    expect(trade).toBeDefined();
    expect(trade!.id).toBe('cap_trade_execution');
    expect(trade!.description).toBe('Submit, validate, and settle orders.');
    expect(trade!.entityCount).toBe(2);
    expect(trade!.flowCount).toBe(1);
  });

  it('includes conceptual-only capabilities with no product_map match', () => {
    const merged = mergeCapabilities(productMap, conceptual);
    const reporting = merged.find(c => c.name === 'Reporting & Audit');
    expect(reporting).toBeDefined();
    expect(reporting!.description).toBeUndefined();
    expect(reporting!.flowCount).toBe(0);
  });

  it('handles both sides being empty/undefined', () => {
    expect(mergeCapabilities(undefined, undefined)).toEqual([]);
  });
});

describe('formatRelativeTime', () => {
  it('returns null for missing/invalid input', () => {
    expect(formatRelativeTime(undefined)).toBeNull();
    expect(formatRelativeTime(null)).toBeNull();
    expect(formatRelativeTime('not-a-date')).toBeNull();
  });

  it('formats a recent timestamp as minutes ago', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatRelativeTime(fiveMinutesAgo)).toBe('5 minutes ago');
  });
});

describe('formatCompactNumber', () => {
  it('passes small numbers through', () => {
    expect(formatCompactNumber(42)).toBe('42');
  });
  it('compacts thousands', () => {
    expect(formatCompactNumber(1500)).toBe('1.5k');
  });
  it('shows a dash for missing values', () => {
    expect(formatCompactNumber(undefined)).toBe('—');
  });
});
