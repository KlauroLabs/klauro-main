import { save } from '$lib/store.js';

export async function keep(item) {
  return save('items', item);
}
