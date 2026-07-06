import React from 'react';
import { useTickets } from '../hooks/useTickets';
import { TicketCard } from '../components/TicketCard';

export function TicketPage(): JSX.Element {
  const { items, loading } = useTickets();

  if (loading) {
    return <div>Loading tickets...</div>;
  }

  return (
    <section className="ticket-page">
      <h1>Tickets</h1>
      <div className="ticket-list">
        {items.map((item) => (
          <TicketCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
