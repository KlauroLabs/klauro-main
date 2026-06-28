export async function loadUsers() {
  const res = await fetch('/users');
  return res.json();
}
export async function loadShipments() {
  const res = await fetch('/shipments');
  return res.json();
}
