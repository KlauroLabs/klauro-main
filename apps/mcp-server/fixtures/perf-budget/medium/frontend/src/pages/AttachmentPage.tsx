import React from 'react';
import { useAttachments } from '../hooks/useAttachments';
import { AttachmentCard } from '../components/AttachmentCard';

export function AttachmentPage(): JSX.Element {
  const { items, loading } = useAttachments();

  if (loading) {
    return <div>Loading attachments...</div>;
  }

  return (
    <section className="attachment-page">
      <h1>Attachments</h1>
      <div className="attachment-list">
        {items.map((item) => (
          <AttachmentCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
