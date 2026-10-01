export function Account() {
  const remove = () => fetch('/api/account', { method: 'DELETE' });
  return <button onClick={remove}>Delete account</button>;
}
