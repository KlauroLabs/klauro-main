import React from 'react';
import { useProjects } from '../hooks/useProjects';
import { ProjectCard } from '../components/ProjectCard';

export function ProjectPage(): JSX.Element {
  const { items, loading } = useProjects();

  if (loading) {
    return <div>Loading projects...</div>;
  }

  return (
    <section className="project-page">
      <h1>Projects</h1>
      <div className="project-list">
        {items.map((item) => (
          <ProjectCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
