export function Unrouted() {
  return <button onClick={() => fetch('/api/never', { method: 'POST' })}>Never shown</button>;
}
