import React from 'react';
import { useContracts } from '../hooks/useContracts';
import { ContractCard } from '../components/ContractCard';

export function ContractPage(): JSX.Element {
  const { items, loading } = useContracts();

  if (loading) {
    return <div>Loading contracts...</div>;
  }

  return (
    <section className="contract-page">
      <h1>Contracts</h1>
      <div className="contract-list">
        {items.map((item) => (
          <ContractCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
