import React from 'react';
import { useNotifications } from '../hooks/useNotifications';
import { NotificationCard } from '../components/NotificationCard';

export function NotificationPage(): JSX.Element {
  const { items, loading } = useNotifications();

  if (loading) {
    return <div>Loading notifications...</div>;
  }

  return (
    <section className="notification-page">
      <h1>Notifications</h1>
      <div className="notification-list">
        {items.map((item) => (
          <NotificationCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
