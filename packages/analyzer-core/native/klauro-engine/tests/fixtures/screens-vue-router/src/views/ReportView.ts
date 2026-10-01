export function ReportView() {
  async function exportReport() {
    await fetch('/api/reports/export', { method: 'POST' });
  }
  return { exportReport };
}
