import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExitPointList } from './ExitPointList';

describe('ExitPointList', () => {
  it('renders an honest empty state when nothing reaches outside the deployable', () => {
    render(<ExitPointList exitPoints={[]} />);
    expect(screen.getByText(/No exit points reach outside/i)).toBeInTheDocument();
  });

  it('renders one row per exit point with its kind', () => {
    render(
      <ExitPointList
        exitPoints={[{ id: 'x1', type: 'database', name: 'Postgres — analyses', target: { resource: 'analyses' } }]}
      />,
    );
    expect(screen.getByText('Postgres — analyses')).toBeInTheDocument();
    expect(screen.getByText('Database')).toBeInTheDocument();
  });
});
