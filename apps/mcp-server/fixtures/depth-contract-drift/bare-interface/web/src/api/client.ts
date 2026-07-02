import { Member } from '../shapes/member';
import { Reward } from '../shapes/reward';
export async function loadMember(id: string): Promise<Member> {
  const res = await fetch(`/api/members/${id}`);
  return res.json();
}
export async function loadReward(id: string): Promise<Reward> {
  const res = await fetch(`/api/rewards/${id}`);
  return res.json();
}
