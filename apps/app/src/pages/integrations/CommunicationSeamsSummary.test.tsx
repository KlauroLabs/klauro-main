import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CommunicationSeamsSummary, summarizeSeams } from './CommunicationSeamsSummary';
import type { ExitPoint } from '../../hooks/useExitPoints';

describe('summarizeSeams', () => {
  it('splits exit points into sync/async by operation.async', () => {
    const points: ExitPoint[] = [
      { id: '1', source_node: 'n1', type: 'database', name: 'q', operation: { async: false } },
      { id: '2', source_node: 'n2', type: 'message', name: 'm', operation: { async: true } },
    ];
    expect(summarizeSeams(points)).toEqual({ sync: 1, async: 1, total: 2 });
  });

  it('excludes file exits from the seam count (device I/O, not a component seam)', () => {
    const points: ExitPoint[] = [{ id: '1', source_node: 'n1', type: 'file', name: 'write log', operation: { async: false } }];
    expect(summarizeSeams(points)).toEqual({ sync: 0, async: 0, total: 0 });
  });

  it('treats a missing async flag as synchronous (the common, unmarked case)', () => {
    const points: ExitPoint[] = [{ id: '1', source_node: 'n1', type: 'database', name: 'q' }];
    expect(summarizeSeams(points)).toEqual({ sync: 1, async: 0, total: 1 });
  });
});

describe('CommunicationSeamsSummary', () => {
  it('renders an honest empty state with no exit points', () => {
    render(<CommunicationSeamsSummary exitPoints={[]} />);
    expect(screen.getByText(/No outbound calls to classify/i)).toBeInTheDocument();
  });

  it('renders sync/async counts', () => {
    render(
      <CommunicationSeamsSummary
        exitPoints={[
          { id: '1', source_node: 'n1', type: 'database', name: 'q', operation: { async: false } },
          { id: '2', source_node: 'n2', type: 'message', name: 'm', operation: { async: true } },
        ]}
      />,
    );
    expect(screen.getByText('1 synchronous')).toBeInTheDocument();
    expect(screen.getByText('1 asynchronous')).toBeInTheDocument();
  });
});
