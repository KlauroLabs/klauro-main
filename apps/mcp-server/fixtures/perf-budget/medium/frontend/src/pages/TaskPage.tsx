import React from 'react';
import { useTasks } from '../hooks/useTasks';
import { TaskCard } from '../components/TaskCard';

export function TaskPage(): JSX.Element {
  const { items, loading } = useTasks();

  if (loading) {
    return <div>Loading tasks...</div>;
  }

  return (
    <section className="task-page">
      <h1>Tasks</h1>
      <div className="task-list">
        {items.map((item) => (
          <TaskCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
