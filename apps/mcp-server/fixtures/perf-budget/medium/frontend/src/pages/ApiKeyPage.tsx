import React from 'react';
import { useApiKeys } from '../hooks/useApiKeys';
import { ApiKeyCard } from '../components/ApiKeyCard';

export function ApiKeyPage(): JSX.Element {
  const { items, loading } = useApiKeys();

  if (loading) {
    return <div>Loading apiKeys...</div>;
  }

  return (
    <section className="apiKey-page">
      <h1>ApiKeys</h1>
      <div className="apiKey-list">
        {items.map((item) => (
          <ApiKeyCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
