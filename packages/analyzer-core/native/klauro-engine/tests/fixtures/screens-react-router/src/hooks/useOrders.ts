export function useOrders() {
  return fetch('/api/orders').then((response) => response.json());
}
