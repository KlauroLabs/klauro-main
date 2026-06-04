import {
  extractJson,
  readGeneratedText,
  normalizeRiskAssessment,
  normalizeRecommendations,
  normalizeCodeAnalysis,
} from '../../ai/providers/local-provider';

describe('local-provider helpers', () => {
  describe('extractJson', () => {
    it('extracts a JSON object embedded in prose', () => {
      const text = 'Here is the result: {"riskLevel":"high","confidence":0.9} done.';
      expect(extractJson(text)).toEqual({ riskLevel: 'high', confidence: 0.9 });
    });

    it('extracts a JSON array embedded in prose', () => {
      const text = 'Recommendations: [{"title":"A"},{"title":"B"}] end';
      expect(extractJson(text)).toEqual([{ title: 'A' }, { title: 'B' }]);
    });

    it('handles nested braces correctly', () => {
      const text = 'x {"a":{"b":{"c":1}},"d":2} y';
      expect(extractJson(text)).toEqual({ a: { b: { c: 1 } }, d: 2 });
    });

    it('returns null when there is no JSON', () => {
      expect(extractJson('no json at all here')).toBeNull();
    });

    it('returns null for malformed JSON', () => {
      expect(extractJson('{ broken: , }')).toBeNull();
    });
  });

  describe('readGeneratedText', () => {
    it('reads a plain string generation', () => {
      expect(readGeneratedText([{ generated_text: 'hello' }])).toBe('hello');
    });

    it('reads the last message of a chat-array generation', () => {
      const out = [
        {
          generated_text: [
            { role: 'user' as const, content: 'q' },
            { role: 'assistant' as const, content: 'the answer' },
          ],
        },
      ];
      expect(readGeneratedText(out)).toBe('the answer');
    });

    it('returns empty string for empty output', () => {
      expect(readGeneratedText([])).toBe('');
    });
  });

  describe('normalizeRiskAssessment', () => {
    it('fills safe defaults for an empty input', () => {
      const r = normalizeRiskAssessment(null);
      expect(r.riskLevel).toBe('medium');
      expect(r.reasons).toEqual([]);
      expect(r.categories).toEqual([]);
      expect(typeof r.confidence).toBe('number');
    });

    it('preserves a valid risk level and coerces categories', () => {
      const r = normalizeRiskAssessment({
        riskLevel: 'high',
        reasons: ['a', 2, 'b'],
        categories: [{ category: 'security', score: 7, issues: ['x'] }],
      });
      expect(r.riskLevel).toBe('high');
      expect(r.reasons).toEqual(['a', 'b']);
      expect(r.categories[0].score).toBe(7);
    });

    it('rejects an invalid risk level', () => {
      expect(normalizeRiskAssessment({ riskLevel: 'banana' }).riskLevel).toBe('medium');
    });
  });

  describe('normalizeRecommendations', () => {
    it('accepts a bare array', () => {
      const recs = normalizeRecommendations([{ title: 'Refactor X' }]);
      expect(recs).toHaveLength(1);
      expect(recs[0].title).toBe('Refactor X');
    });

    it('accepts a wrapped { recommendations: [...] } object', () => {
      const recs = normalizeRecommendations({ recommendations: [{ title: 'Y' }] });
      expect(recs).toHaveLength(1);
      expect(recs[0].title).toBe('Y');
    });

    it('returns an empty array for junk', () => {
      expect(normalizeRecommendations('nonsense')).toEqual([]);
    });
  });

  describe('normalizeCodeAnalysis', () => {
    it('falls back to raw text for the summary when none is parsed', () => {
      const a = normalizeCodeAnalysis(null, '  some raw analysis text  ');
      expect(a.summary).toBe('some raw analysis text');
    });

    it('reads complexity numbers when present', () => {
      const a = normalizeCodeAnalysis(
        { summary: 'S', complexity: { cyclomatic: 5, cognitive: 3 } },
        'raw',
      );
      expect(a.summary).toBe('S');
      expect(a.complexity.cyclomatic).toBe(5);
      expect(a.complexity.cognitive).toBe(3);
    });
  });
});
