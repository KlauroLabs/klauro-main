import React from 'react';
import { useAudits } from '../hooks/useAudits';
import { AuditCard } from '../components/AuditCard';

export function AuditPage(): JSX.Element {
  const { items, loading } = useAudits();

  if (loading) {
    return <div>Loading audits...</div>;
  }

  return (
    <section className="audit-page">
      <h1>Audits</h1>
      <div className="audit-list">
        {items.map((item) => (
          <AuditCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
