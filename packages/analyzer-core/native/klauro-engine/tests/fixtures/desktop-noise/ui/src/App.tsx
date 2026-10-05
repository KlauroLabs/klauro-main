import { invoke } from '@tauri-apps/api/core';

export function useNote(id: string) {
  return invoke('read_note', { id });
}

export function NoteEditor() {
  return <button onClick={() => invoke('write_note', { id: '1', body: 'x' })}>Save</button>;
}

export function App() {
  return <NoteEditor />;
}
