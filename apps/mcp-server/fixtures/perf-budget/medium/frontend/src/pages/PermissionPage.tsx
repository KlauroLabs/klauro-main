import React from 'react';
import { usePermissions } from '../hooks/usePermissions';
import { PermissionCard } from '../components/PermissionCard';

export function PermissionPage(): JSX.Element {
  const { items, loading } = usePermissions();

  if (loading) {
    return <div>Loading permissions...</div>;
  }

  return (
    <section className="permission-page">
      <h1>Permissions</h1>
      <div className="permission-list">
        {items.map((item) => (
          <PermissionCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
