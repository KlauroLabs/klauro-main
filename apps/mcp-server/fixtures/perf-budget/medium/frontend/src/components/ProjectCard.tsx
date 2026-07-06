import React from 'react';
import type { Project } from '../types/project';

interface ProjectCardProps {
  item: Project;
  onSelect?: (id: string) => void;
}

export function ProjectCard({ item, onSelect }: ProjectCardProps): JSX.Element {
  return (
    <div className="project-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
