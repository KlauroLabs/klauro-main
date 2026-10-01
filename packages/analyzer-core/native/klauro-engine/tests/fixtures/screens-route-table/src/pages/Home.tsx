export default function Home() {
  return <button onClick={() => fetch('/api/welcome', { method: 'POST' })}>Hello</button>;
}
