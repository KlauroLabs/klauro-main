import { money } from '../../shared/src/format';

export async function loadOrder(id: string) {
  const reply = await fetch(`/api/orders/${id}`);
  return money((await reply.json()).total);
}

export async function loadMissing(id: string) {
  return fetch(`/api/nowhere/${id}`);
}
