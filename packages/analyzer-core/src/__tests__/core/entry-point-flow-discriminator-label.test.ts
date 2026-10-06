// A entryPointFlow discriminator is rendered inside the entryPointFlow title a customer
// reads first, so a repo path must never reach it. Measured live on a Python
// app whose entryPointFlows shipped as `Config (<dir>/<file>.py)`.
import { discriminatorLabel } from '../../analyzer/core/entry-point-flow-builder';

describe('entryPointFlow discriminator label', () => {
  it('turns a source path into a readable name instead of exposing the path', () => {
    const label = discriminatorLabel('rvc-webui/api_231006.py');
    expect(label).not.toContain('/');
    expect(label).not.toContain('.py');
    // The distinguishing token survives — two such entryPointFlows must still differ.
    expect(label).toContain('231006');
  });

  it('keeps two paths distinguishable after relabelling', () => {
    const first = discriminatorLabel('rvc-webui/api_231006.py');
    const second = discriminatorLabel('rvc-webui/api_240604.py');
    expect(first).not.toEqual(second);
  });

  it('widens by one path segment per depth, so a colliding stem can be distinguished', () => {
    // Genericness is a property of the SET, not of the word "main": at depth 1
    // these two collide, and the caller's job is to widen until they don't.
    expect(discriminatorLabel('audio_processor/src/main.py', 1))
      .toEqual(discriminatorLabel('gateway/lib/main.py', 1));
    expect(discriminatorLabel('audio_processor/src/main.py', 2))
      .not.toEqual(discriminatorLabel('gateway/lib/main.py', 2));
    const wide = discriminatorLabel('audio_processor/src/main.py', 2);
    expect(wide.toLowerCase()).toContain('src');
    expect(wide).not.toContain('/');
  });

  it('never exposes a path no matter how wide the label gets', () => {
    for (const depth of [1, 2, 3, 9]) {
      const label = discriminatorLabel('a/b/c/deep_handler.py', depth);
      expect(label).not.toContain('/');
      expect(label).not.toContain('.py');
    }
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
