const BASE = '/api';

export async function loadOrder(id: string) {
  return fetch(BASE + '/orders/' + id);
}
