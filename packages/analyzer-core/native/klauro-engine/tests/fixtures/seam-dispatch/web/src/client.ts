const base = 'http://localhost:8787';

export const api = {
  health: () => fetch(`${base}/health`),
  report: () => fetch(`${base}/api/reports/daily`),
  engine: (name: string) => fetch(`${base}/api/engine/${name}`),
  query: (id: string) => fetch(`${base}/api/projects/${id}/query`, { method: 'POST' }),
  remove: (id: string) => fetch(`${base}/api/projects/${id}`, { method: 'DELETE' }),
  list: () => fetch(`${base}/api/projects`),
};

function joinUrl(root: string, route: string): string {
  return `${root}${route}`;
}

export async function status(root: string) {
  return fetch(joinUrl(root, '/status'));
}
