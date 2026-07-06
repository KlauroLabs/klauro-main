import React from 'react';
import { useReviews } from '../hooks/useReviews';
import { ReviewCard } from '../components/ReviewCard';

export function ReviewPage(): JSX.Element {
  const { items, loading } = useReviews();

  if (loading) {
    return <div>Loading reviews...</div>;
  }

  return (
    <section className="review-page">
      <h1>Reviews</h1>
      <div className="review-list">
        {items.map((item) => (
          <ReviewCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
