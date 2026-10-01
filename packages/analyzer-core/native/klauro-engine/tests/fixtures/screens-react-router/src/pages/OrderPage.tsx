import { useState } from 'react';
import { OrderLines } from '../components/OrderLines';

export default function OrderPage() {
  const [busy, setBusy] = useState(false);
  async function handleCancel() {
    setBusy(true);
    await fetch('/api/orders/cancel', { method: 'POST' });
    setBusy(false);
  }
  return (
    <div>
      <button disabled={busy} onClick={handleCancel}>Cancel order</button>
      <OrderLines />
    </div>
  );
}
