import React from 'react';
import { useQuotes } from '../hooks/useQuotes';
import { QuoteCard } from '../components/QuoteCard';

export function QuotePage(): JSX.Element {
  const { items, loading } = useQuotes();

  if (loading) {
    return <div>Loading quotes...</div>;
  }

  return (
    <section className="quote-page">
      <h1>Quotes</h1>
      <div className="quote-list">
        {items.map((item) => (
          <QuoteCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
