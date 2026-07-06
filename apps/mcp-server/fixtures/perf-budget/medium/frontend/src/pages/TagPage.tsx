import React from 'react';
import { useTags } from '../hooks/useTags';
import { TagCard } from '../components/TagCard';

export function TagPage(): JSX.Element {
  const { items, loading } = useTags();

  if (loading) {
    return <div>Loading tags...</div>;
  }

  return (
    <section className="tag-page">
      <h1>Tags</h1>
      <div className="tag-list">
        {items.map((item) => (
          <TagCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
