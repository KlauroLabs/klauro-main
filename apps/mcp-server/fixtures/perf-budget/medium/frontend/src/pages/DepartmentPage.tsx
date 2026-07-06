import React from 'react';
import { useDepartments } from '../hooks/useDepartments';
import { DepartmentCard } from '../components/DepartmentCard';

export function DepartmentPage(): JSX.Element {
  const { items, loading } = useDepartments();

  if (loading) {
    return <div>Loading departments...</div>;
  }

  return (
    <section className="department-page">
      <h1>Departments</h1>
      <div className="department-list">
        {items.map((item) => (
          <DepartmentCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
