import React from 'react';
import { useTeams } from '../hooks/useTeams';
import { TeamCard } from '../components/TeamCard';

export function TeamPage(): JSX.Element {
  const { items, loading } = useTeams();

  if (loading) {
    return <div>Loading teams...</div>;
  }

  return (
    <section className="team-page">
      <h1>Teams</h1>
      <div className="team-list">
        {items.map((item) => (
          <TeamCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
