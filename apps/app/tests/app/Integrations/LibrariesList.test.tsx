import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LibrariesList } from '@/app/Integrations/LibrariesList';

describe('LibrariesList', () => {
  it('renders an honest empty state when no manifest was found at all', () => {
    render(<LibrariesList libraries={[]} />);
    expect(screen.getByText(/No dependency manifest found/i)).toBeInTheDocument();
  });

  it('renders recognized libraries by default', () => {
    render(<LibrariesList libraries={[{ id: 'l1', name: '@mikro-orm/core', version: '6.3.10', type: 'production' }]} />);
    expect(screen.getByText('@mikro-orm/core — 6.3.10')).toBeInTheDocument();
    expect(screen.getByText('Runtime')).toBeInTheDocument();
  });

  it('toggles to the full declared-dependency manifest', () => {
    render(
      <LibrariesList
        libraries={[{ id: 'l1', name: 'express', type: 'production' }]}
        dependencyManifest={{
          manifests: ['package.json'],
          total: 2,
          dependencies: [{ name: 'express', ecosystem: 'npm', scopes: ['runtime'], declared_in: ['package.json'] }],
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /All declared/i }));
    expect(screen.getByText('package.json')).toBeInTheDocument();
  });
});
