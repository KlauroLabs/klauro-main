// Client-side view-recency tracking. The "Jump Back In" card (Figma "Home",
// node 1698-13626) shows a "Last Opened Xh ago" timestamp — no per-user
// view/click history exists anywhere in the API surface (`api.ts` has no
// "viewed_at"/"opened_at" concept; see apps/app/docs/DESIGN-NOTES.md,
// "'Jump Back In' stats have no data source — data gap"). That entry already
// notes the honest substitute this repo picked for WHICH project to feature
// (most recent successful analysis); this hook feeds the "Last Opened" field
// ITSELF, which the Figma frame explicitly shows and no analysis timestamp
// should impersonate. It's real, local, per-browser data: recorded the
// moment a user actually opens a codebase (`CodebasePage`'s mount effect),
// read back by `JumpBackInCard`. Cross-device/incognito/first-ever-visit
// legitimately has nothing recorded — that renders an honest "—", not a
// fabricated relative time.
const STORAGE_KEY = 'klauro:project-last-opened';

function readMap(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    // localStorage unavailable (private browsing, SSR, disabled storage) —
    // an honest no-op, same stance the rest of this lane's hooks take for
    // absent data.
    return {};
  }
}

/** Record "now" as this project's last-opened time. Call once per visit. */
export function recordProjectOpened(projectId: string): void {
  if (!projectId) return;
  try {
    const map = readMap();
    map[projectId] = new Date().toISOString();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Same honest no-op as above — a failed write just means "Last Opened"
    // stays unrecorded for this browser, not a thrown error mid-navigation.
  }
}

/** Read this project's last-opened time, if this browser has ever recorded one. */
export function getLastOpenedAt(projectId: string | undefined): string | undefined {
  if (!projectId) return undefined;
  return readMap()[projectId];
}
