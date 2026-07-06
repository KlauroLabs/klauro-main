import React from 'react';
import type { Comment } from '../types/comment';

interface CommentCardProps {
  item: Comment;
  onSelect?: (id: string) => void;
}

export function CommentCard({ item, onSelect }: CommentCardProps): JSX.Element {
  return (
    <div className="comment-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
