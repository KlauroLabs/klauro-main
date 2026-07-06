import React from 'react';
import { useCompanys } from '../hooks/useCompanys';
import { CompanyCard } from '../components/CompanyCard';

export function CompanyPage(): JSX.Element {
  const { items, loading } = useCompanys();

  if (loading) {
    return <div>Loading companys...</div>;
  }

  return (
    <section className="company-page">
      <h1>Companys</h1>
      <div className="company-list">
        {items.map((item) => (
          <CompanyCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
