import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { EntryKindIcon } from '@/shared/components/EntryKindIcon';
import { KIND_META } from '@/shared/components/entryPointKinds';

describe('EntryKindIcon', () => {
  it('renders a distinct outlined glyph for every kind in the vocabulary without throwing', () => {
    for (const kind of Object.keys(KIND_META) as Array<keyof typeof KIND_META>) {
      const { container, unmount } = render(<EntryKindIcon kind={kind} />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
      // stroke-only per the design language — never a filled illustration.
      expect(svg?.getAttribute('fill')).toBe('none');
      unmount();
    }
  });

  it('falls back to the accent color when accent is set', () => {
    const { container } = render(<EntryKindIcon kind="http" accent />);
    const rect = container.querySelector('rect');
    expect(rect?.getAttribute('stroke')).toBe('#E6414B');
  });
});
