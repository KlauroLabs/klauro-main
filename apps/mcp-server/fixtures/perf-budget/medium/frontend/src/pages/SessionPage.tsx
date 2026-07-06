import React from 'react';
import { useSessions } from '../hooks/useSessions';
import { SessionCard } from '../components/SessionCard';

export function SessionPage(): JSX.Element {
  const { items, loading } = useSessions();

  if (loading) {
    return <div>Loading sessions...</div>;
  }

  return (
    <section className="session-page">
      <h1>Sessions</h1>
      <div className="session-list">
        {items.map((item) => (
          <SessionCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
