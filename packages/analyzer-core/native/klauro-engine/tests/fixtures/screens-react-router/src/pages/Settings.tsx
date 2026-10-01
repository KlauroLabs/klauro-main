export default function SettingsPage() {
  return <button onClick={() => fetch('/api/settings', { method: 'PUT' })}>Save settings</button>;
}
