import { invoke } from '@tauri-apps/api/core';

export async function openProject(path: string) {
  return invoke('read_project', { path });
}

export async function saveProject(path: string) {
  return invoke<void>('write_project', { path });
}

export async function lookup() {
  return invoke('no_such_command');
}
