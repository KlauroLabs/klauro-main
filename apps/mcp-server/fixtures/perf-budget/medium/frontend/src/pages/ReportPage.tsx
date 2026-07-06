import React from 'react';
import { useReports } from '../hooks/useReports';
import { ReportCard } from '../components/ReportCard';

export function ReportPage(): JSX.Element {
  const { items, loading } = useReports();

  if (loading) {
    return <div>Loading reports...</div>;
  }

  return (
    <section className="report-page">
      <h1>Reports</h1>
      <div className="report-list">
        {items.map((item) => (
          <ReportCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
