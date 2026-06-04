export function UserCard({ name, email }: { name: string; email: string }) {
  return (
    <article>
      <strong>{name}</strong>
      <span>{email}</span>
    </article>
  );
}
