import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExternalServicesList } from '@/app/Integrations/ExternalServicesList';

describe('ExternalServicesList', () => {
  it('renders an honest empty state when nothing resolves to a named service', () => {
    render(<ExternalServicesList services={[]} />);
    expect(screen.getByText(/No named external services detected/i)).toBeInTheDocument();
  });

  it('renders one row per service with its evidence count', () => {
    render(
      <ExternalServicesList
        services={[
          { id: 's1', name: 'Redis', type: 'cache', purpose: 'bidirectional', exit_points: ['a', 'b', 'c'] },
        ]}
      />,
    );
    expect(screen.getByText('Redis')).toBeInTheDocument();
    expect(screen.getByText('3 touching calls')).toBeInTheDocument();
    expect(screen.getByText('Two-way')).toBeInTheDocument();
  });
});
