import React from 'react';
import { useLeads } from '../hooks/useLeads';
import { LeadCard } from '../components/LeadCard';

export function LeadPage(): JSX.Element {
  const { items, loading } = useLeads();

  if (loading) {
    return <div>Loading leads...</div>;
  }

  return (
    <section className="lead-page">
      <h1>Leads</h1>
      <div className="lead-list">
        {items.map((item) => (
          <LeadCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
