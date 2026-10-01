export function Inbox() {
  return <button onClick={() => fetch('/api/inbox/read', { method: 'POST' })}>Mark read</button>;
}
