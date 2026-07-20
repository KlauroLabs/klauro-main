import '@testing-library/jest-dom/vitest';

// vitest's jsdom environment leaves `window.localStorage`/`globalThis.localStorage`
// undefined on newer Node (Node ships its own experimental, opt-in-only
// localStorage that conflicts with jsdom's, so vitest doesn't wire jsdom's up).
// main.tsx reads/writes the bare `localStorage` global exactly as it would in
// a real browser, so tests need a real implementation present. A minimal
// in-memory Storage is enough — nothing here needs persistence or quotas.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() { return this.store.size; }
  clear() { this.store.clear(); }
  getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null; }
  key(index: number) { return Array.from(this.store.keys())[index] ?? null; }
  removeItem(key: string) { this.store.delete(key); }
  setItem(key: string, value: string) { this.store.set(key, String(value)); }
}
const memoryStorage = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true });
Object.defineProperty(window, 'localStorage', { value: memoryStorage, configurable: true });
