export function OrderLines() {
  return <button onClick={() => fetch('/api/orders/lines', { method: 'DELETE' })}>Remove line</button>;
}
