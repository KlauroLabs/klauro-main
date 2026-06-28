import { Wallet } from '../entities/wallet';
import { Invoice } from '../entities/invoice';
export async function loadWallet(id: string): Promise<Wallet> {
  const res = await fetch(`/api/wallets/${id}`);
  return res.json();
}
export async function loadInvoice(id: string): Promise<Invoice> {
  const res = await fetch(`/api/invoices/${id}`);
  return res.json();
}
