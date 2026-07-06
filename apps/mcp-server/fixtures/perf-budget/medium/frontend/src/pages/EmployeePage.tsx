import React from 'react';
import { useEmployees } from '../hooks/useEmployees';
import { EmployeeCard } from '../components/EmployeeCard';

export function EmployeePage(): JSX.Element {
  const { items, loading } = useEmployees();

  if (loading) {
    return <div>Loading employees...</div>;
  }

  return (
    <section className="employee-page">
      <h1>Employees</h1>
      <div className="employee-list">
        {items.map((item) => (
          <EmployeeCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
