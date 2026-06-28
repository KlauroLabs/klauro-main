import { WalletDto } from '../types/wallet-dto';
import { InvoiceDto } from '../types/invoice-dto';

export async function loadWallet(id: string): Promise<WalletDto> {
  const res = await fetch(`/api/wallets/${id}`);
  return res.json();
}

export async function loadInvoice(id: string): Promise<InvoiceDto> {
  const res = await fetch(`/api/invoices/${id}`);
  return res.json();
}
