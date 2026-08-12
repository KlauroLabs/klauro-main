// A journey discriminator is rendered inside the journey title a customer
// reads first, so a repo path must never reach it. Measured live on a Python
// app whose journeys shipped as `Config (<dir>/<file>.py)`.
import { discriminatorLabel } from '../../analyzer/core/journey-builder';

describe('journey discriminator label', () => {
  it('turns a source path into a readable name instead of exposing the path', () => {
    const label = discriminatorLabel('rvc-webui/api_231006.py');
    expect(label).not.toContain('/');
    expect(label).not.toContain('.py');
    // The distinguishing token survives — two such journeys must still differ.
    expect(label).toContain('231006');
  });

  it('keeps two paths distinguishable after relabelling', () => {
    const first = discriminatorLabel('rvc-webui/api_231006.py');
    const second = discriminatorLabel('rvc-webui/api_240604.py');
    expect(first).not.toEqual(second);
  });

  it('qualifies a generic stem with its parent directory so it still distinguishes', () => {
    // `main.py` alone names nothing; the directory is what identifies it.
    const label = discriminatorLabel('audio_processor/src/main.py');
    expect(label.toLowerCase()).toContain('src');
    expect(label).not.toContain('/');
    expect(discriminatorLabel('audio_processor/src/main.py'))
      .not.toEqual(discriminatorLabel('gateway/lib/main.py'));
  });

  it('leaves a real identifier untouched', () => {
    // Not path-shaped: no separator, no extension. Must pass through verbatim,
    // or every ordinary handler name would be rewritten too.
    expect(discriminatorLabel('createOrder')).toBe('createOrder');
    expect(discriminatorLabel('UserController')).toBe('UserController');
  });

  it('is a no-op on empty input rather than inventing a label', () => {
    expect(discriminatorLabel(undefined)).toBe('');
    expect(discriminatorLabel('')).toBe('');
  });
});
