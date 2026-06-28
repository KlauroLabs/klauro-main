export async function chargeCustomer(amount: number) {
  const res = await fetch('/payments/charges', { method: 'POST', body: JSON.stringify({ amount }) });
  return res.json();
}
export async function fetchInventory() {
  const res = await fetch('/inventory/items');
  return res.json();
}
