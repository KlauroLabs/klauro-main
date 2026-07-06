import React from 'react';
import { useComments } from '../hooks/useComments';
import { CommentCard } from '../components/CommentCard';

export function CommentPage(): JSX.Element {
  const { items, loading } = useComments();

  if (loading) {
    return <div>Loading comments...</div>;
  }

  return (
    <section className="comment-page">
      <h1>Comments</h1>
      <div className="comment-list">
        {items.map((item) => (
          <CommentCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
