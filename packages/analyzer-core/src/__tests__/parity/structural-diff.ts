/**
 * Minimal structural differ used by the extractor differential-parity harness.
 *
 * Why not `assert.deepStrictEqual` alone: deepStrictEqual answers "are these
 * equal?" and, when they are not, prints a whole-object diff. Over a
 * `TSFileExtraction` for a 1000-line source file that blob is unreadable and
 * unactionable. This differ answers the question the harness actually needs:
 * "WHERE is the first divergence, expressed as a JSON path, and what are the
 * two values there?" — so a failure names `functions[12].calls[3].name`
 * instead of dumping two megabytes of JSON.
 *
 * Equality semantics deliberately match `deepStrictEqual`:
 *   - an own key present with value `undefined` differs from an absent key
 *   - arrays differ on length before element comparison
 *   - `NaN` equals `NaN`; `0` and `-0` are distinct
 */

export interface StructuralDivergence {
  /** JSON path from the extraction root, e.g. `functions[3].calls[0].name`. */
  path: string;
  /** Value produced by the pre-rewrite (baseline) extractor. */
  baseline: unknown;
  /** Value produced by the current extractor. */
  current: unknown;
  /**
   * Coarse classification of the divergence, used to categorize a run:
   * `missing-in-current`, `extra-in-current`, `length`, `type`, or `value`.
   */
  kind: DivergenceKind;
}

export type DivergenceKind =
  | 'missing-in-current'
  | 'extra-in-current'
  | 'length'
  | 'type'
  | 'value';

const ABSENT = Symbol('absent');

function typeTag(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function sameScalar(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return Object.is(a, b);
  }
  return a === b;
}

function child(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

/**
 * Walk both values in lockstep, appending every divergence found (depth-first,
 * source order) until `limit` is reached. Returns divergences in the order
 * encountered, so `[0]` is the FIRST divergence — the one worth reporting.
 */
export function diffStructural(
  baseline: unknown,
  current: unknown,
  limit = 5,
  path = '',
  out: StructuralDivergence[] = [],
): StructuralDivergence[] {
  if (out.length >= limit) return out;

  const bTag = typeTag(baseline);
  const cTag = typeTag(current);

  if (bTag !== cTag) {
    out.push({ path: path || '<root>', baseline, current, kind: 'type' });
    return out;
  }

  if (bTag === 'array') {
    const b = baseline as unknown[];
    const c = current as unknown[];
    if (b.length !== c.length) {
      out.push({
        path: `${path || '<root>'}.length`,
        baseline: b.length,
        current: c.length,
        kind: 'length',
      });
      // Still descend: the element-level divergence is usually the real story
      // (e.g. one extra call recorded), and reporting only "length differs"
      // sends the reader hunting.
    }
    const shared = Math.min(b.length, c.length);
    for (let i = 0; i < shared; i++) {
      if (out.length >= limit) return out;
      diffStructural(b[i], c[i], limit, `${path}[${i}]`, out);
    }
    return out;
  }

  if (bTag === 'object') {
    const b = baseline as Record<string, unknown>;
    const c = current as Record<string, unknown>;
    const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(c)]));
    for (const key of keys) {
      if (out.length >= limit) return out;
      const bHas = Object.prototype.hasOwnProperty.call(b, key);
      const cHas = Object.prototype.hasOwnProperty.call(c, key);
      if (bHas && !cHas) {
        out.push({
          path: child(path, key),
          baseline: b[key],
          current: ABSENT as unknown,
          kind: 'missing-in-current',
        });
        continue;
      }
      if (!bHas && cHas) {
        out.push({
          path: child(path, key),
          baseline: ABSENT as unknown,
          current: c[key],
          kind: 'extra-in-current',
        });
        continue;
      }
      diffStructural(b[key], c[key], limit, child(path, key), out);
    }
    return out;
  }

  if (!sameScalar(baseline, current)) {
    out.push({ path: path || '<root>', baseline, current, kind: 'value' });
  }
  return out;
}

/** Render a value for a failure message: absent marker, short JSON, or ellipsis. */
export function renderValue(value: unknown, maxLen = 240): string {
  if ((value as unknown) === ABSENT) return '<absent>';
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = 'undefined';
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

/**
 * Collapse a concrete path to a stable bucket for categorization:
 * `functions[12].calls[3].name` -> `functions[].calls[].name`.
 */
export function pathShape(path: string): string {
  return path.replace(/\[\d+\]/g, '[]');
}
