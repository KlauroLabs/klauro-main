import React from 'react';
import { useSettings } from '../hooks/useSettings';
import { SettingCard } from '../components/SettingCard';

export function SettingPage(): JSX.Element {
  const { items, loading } = useSettings();

  if (loading) {
    return <div>Loading settings...</div>;
  }

  return (
    <section className="setting-page">
      <h1>Settings</h1>
      <div className="setting-list">
        {items.map((item) => (
          <SettingCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
