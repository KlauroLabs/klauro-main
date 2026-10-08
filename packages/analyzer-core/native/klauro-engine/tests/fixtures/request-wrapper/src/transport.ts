import { fetch as transportFetch } from 'undici';

export async function send(url: string | URL, init: RequestInit) {
  const target = url.toString();
  return transportFetch(target, init);
}

export async function archiveReport(base: string, id: string) {
  const url = `${base}/api/reports/${encodeURIComponent(id)}/archive`;
  return send(url, { method: 'POST' });
}
