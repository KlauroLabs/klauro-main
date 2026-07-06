import React from 'react';
import { useUsers } from '../hooks/useUsers';
import { UserCard } from '../components/UserCard';

export function UserPage(): JSX.Element {
  const { items, loading } = useUsers();

  if (loading) {
    return <div>Loading users...</div>;
  }

  return (
    <section className="user-page">
      <h1>Users</h1>
      <div className="user-list">
        {items.map((item) => (
          <UserCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
