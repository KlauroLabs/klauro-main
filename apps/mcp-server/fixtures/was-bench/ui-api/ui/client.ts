export async function loadInvoices() {
  const res = await fetch('/invoices');
  return res.json();
}
export async function createInvoice(amount: number) {
  await fetch('/invoices', { method: 'POST', body: JSON.stringify({ amount }) });
}
