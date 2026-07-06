import React from 'react';
import { useProducts } from '../hooks/useProducts';
import { ProductCard } from '../components/ProductCard';

export function ProductPage(): JSX.Element {
  const { items, loading } = useProducts();

  if (loading) {
    return <div>Loading products...</div>;
  }

  return (
    <section className="product-page">
      <h1>Products</h1>
      <div className="product-list">
        {items.map((item) => (
          <ProductCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
