import React from 'react';
import type { Task } from '../types/task';

interface TaskCardProps {
  item: Task;
  onSelect?: (id: string) => void;
}

export function TaskCard({ item, onSelect }: TaskCardProps): JSX.Element {
  return (
    <div className="task-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
