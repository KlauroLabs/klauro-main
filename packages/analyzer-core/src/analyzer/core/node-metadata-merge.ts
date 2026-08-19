import type { CASNode } from '../../types/cas.types';

function mergeArrayValues(left: unknown[], right: unknown[]): unknown[] {
  const seen = new Set(right.map(value => JSON.stringify(value)));
  return [...right, ...left.filter(value => !seen.has(JSON.stringify(value)))];
}

function mergeRecords(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...left, ...right };
  for (const [key, leftValue] of Object.entries(left || {})) {
    const rightValue = right?.[key];
    if (Array.isArray(leftValue) && Array.isArray(rightValue)) {
      merged[key] = mergeArrayValues(leftValue, rightValue);
    }
  }
  return merged;
}

export function mergeNodeMetadata(loser: CASNode, survivor: CASNode): void {
  if (!loser.metadata) return;
  const merged = mergeRecords(
    loser.metadata as Record<string, unknown>,
    survivor.metadata as Record<string, unknown> | undefined,
  );
  const loserAttributes = loser.metadata.attributes as Record<string, unknown> | undefined;
  const survivorAttributes = survivor.metadata?.attributes as Record<string, unknown> | undefined;
  if (loserAttributes || survivorAttributes) {
    merged.attributes = mergeRecords(loserAttributes, survivorAttributes);
  }
  survivor.metadata = merged as typeof survivor.metadata;
}
