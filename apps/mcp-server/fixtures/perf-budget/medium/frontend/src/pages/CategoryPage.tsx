import React from 'react';
import { useCategorys } from '../hooks/useCategorys';
import { CategoryCard } from '../components/CategoryCard';

export function CategoryPage(): JSX.Element {
  const { items, loading } = useCategorys();

  if (loading) {
    return <div>Loading categorys...</div>;
  }

  return (
    <section className="category-page">
      <h1>Categorys</h1>
      <div className="category-list">
        {items.map((item) => (
          <CategoryCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
