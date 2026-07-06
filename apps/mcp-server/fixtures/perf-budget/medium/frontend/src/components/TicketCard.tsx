import React from 'react';
import type { Ticket } from '../types/ticket';

interface TicketCardProps {
  item: Ticket;
  onSelect?: (id: string) => void;
}

export function TicketCard({ item, onSelect }: TicketCardProps): JSX.Element {
  return (
    <div className="ticket-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
