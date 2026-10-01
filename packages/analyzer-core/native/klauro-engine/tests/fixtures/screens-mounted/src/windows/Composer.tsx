export function Composer() {
  return <button onClick={() => fetch('/api/send', { method: 'POST' })}>Send</button>;
}
