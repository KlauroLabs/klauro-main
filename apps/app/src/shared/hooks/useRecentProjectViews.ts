const STORAGE_KEY = 'klauro:project-last-opened';

function readMap(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {

    return {};
  }
}

export function recordProjectOpened(projectId: string): void {
  if (!projectId) return;
  try {
    const map = readMap();
    map[projectId] = new Date().toISOString();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {

  }
}

export function getLastOpenedAt(projectId: string | undefined): string | undefined {
  if (!projectId) return undefined;
  return readMap()[projectId];
}
