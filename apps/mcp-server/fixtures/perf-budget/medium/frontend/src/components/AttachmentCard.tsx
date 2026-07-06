import React from 'react';
import type { Attachment } from '../types/attachment';

interface AttachmentCardProps {
  item: Attachment;
  onSelect?: (id: string) => void;
}

export function AttachmentCard({ item, onSelect }: AttachmentCardProps): JSX.Element {
  return (
    <div className="attachment-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
