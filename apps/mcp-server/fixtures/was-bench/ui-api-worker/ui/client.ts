export async function loadOrders() {
  const res = await fetch('/orders');
  return res.json();
}
