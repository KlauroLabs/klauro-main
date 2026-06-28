import express from 'express';
import { WalletDto } from './types/wallet-dto';
import { InvoiceDto } from './types/invoice-dto';

const app = express();

app.get('/api/wallets/:id', (req, res) => {
  const wallet: WalletDto = { id: 'wallet_1', balance: 2500, status: 'active' };
  res.json(wallet);
});

app.get('/api/invoices/:id', (req, res) => {
  const invoice: InvoiceDto = { id: 'invoice_1', total: 99 };
  res.json(invoice);
});

export { app };
