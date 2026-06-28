import { Profile } from '../entities/profile';
import { Setting } from '../entities/setting';
export async function loadProfile(id: string): Promise<Profile> {
  const res = await fetch(`/api/profiles/${id}`);
  return res.json();
}
export async function loadSetting(id: string): Promise<Setting> {
  const res = await fetch(`/api/settings/${id}`);
  return res.json();
}
