import React from 'react';
import { useWebhooks } from '../hooks/useWebhooks';
import { WebhookCard } from '../components/WebhookCard';

export function WebhookPage(): JSX.Element {
  const { items, loading } = useWebhooks();

  if (loading) {
    return <div>Loading webhooks...</div>;
  }

  return (
    <section className="webhook-page">
      <h1>Webhooks</h1>
      <div className="webhook-list">
        {items.map((item) => (
          <WebhookCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
