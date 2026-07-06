import React from 'react';
import { useRoles } from '../hooks/useRoles';
import { RoleCard } from '../components/RoleCard';

export function RolePage(): JSX.Element {
  const { items, loading } = useRoles();

  if (loading) {
    return <div>Loading roles...</div>;
  }

  return (
    <section className="role-page">
      <h1>Roles</h1>
      <div className="role-list">
        {items.map((item) => (
          <RoleCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
